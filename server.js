const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')
const webpush = require('web-push')
const app = express()
app.use(express.json())
app.use(function(req,res,next){
  res.header('Access-Control-Allow-Origin','*')
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  res.header('Access-Control-Allow-Headers','Content-Type,Authorization')
  if(req.method==='OPTIONS')return res.sendStatus(200)
  next()
})

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY

console.log('SUPABASE_URL:', SUPABASE_URL ? 'set' : 'MISSING')
console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'set' : 'MISSING')
console.log('OPENPHONE_API_KEY:', OPENPHONE_API_KEY ? 'set' : 'MISSING')
console.log('VAPID keys:', VAPID_PUBLIC ? 'set' : 'MISSING')

if(VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:info@uneditedcontentstudio.com', VAPID_PUBLIC, VAPID_PRIVATE)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: ws } })

async function sendPushToClient(clientId, title, body) {
  try {
    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('client_id', clientId)
    if (!subs || subs.length === 0) { console.log('No push subscriptions for client:', clientId); return }
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/icon-192.png' }))
        console.log('Push sent to', clientId)
      } catch(e) {
        console.log('Push failed for sub:', e.statusCode, e.message)
        if(e.statusCode === 410 || e.statusCode === 404) {
          await sb.from('push_subscriptions').delete().eq('id', sub.id)
        }
      }
    }
  } catch(e) {
    console.error('sendPushToClient error:', e.message)
  }
}

async function testConnection() {
  try {
    const { data, error } = await sb.from('clients').select('id').limit(1)
    if (error) console.log('Supabase error:', error.message)
    else console.log('Supabase OK, clients:', data?.length)
  } catch (e) { console.error('Supabase exception:', e.message) }
}

app.get('/', (req, res) => res.json({ ok: true, service: 'UCS Webhook', vapid_public: VAPID_PUBLIC }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received type:', body?.type || body?.action)

  try {
    // ── SAVE PUSH SUBSCRIPTION ──
    if (body?.action === 'subscribe') {
      const { client_id, subscription } = body
      if (!client_id || !subscription) return res.json({ ok: false, error: 'missing fields' })
      await sb.from('push_subscriptions').upsert({ client_id, subscription, updated_at: new Date().toISOString() }, { onConflict: 'client_id,endpoint' })
      console.log('Push subscription saved for client:', client_id)
      return res.json({ ok: true })
    }

    // ── SEND PUSH NOTIFICATION ──
    if (body?.action === 'push') {
      const { client_id, title, body: msg } = body
      await sendPushToClient(client_id, title, msg)
      return res.json({ ok: true })
    }

    // ── OUTBOUND SMS ──
    if (body?.action === 'send') {
      let { to, message } = body
      if (to && !to.startsWith('+')) to = '+1' + to.replace(/[^\d]/g, '')
      console.log('Sending SMS to:', to)
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: { 'Authorization': OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message, from: 'PN7bGOiGL0', to: [to] })
      })
      const data = await response.json()
      console.log('OpenPhone response:', response.status)
      return res.json({ ok: response.ok, data })
    }

    // ── INBOUND SMS ──
    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || ''
      if (!from || !text) return res.json({ ok: true, skipped: 'no from/text' })
      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)
      console.log('Inbound from:', cleanPhone)
      const { data: clients } = await sb.from('clients').select('id,first_name,phone').limit(200)
      const client = (clients || []).find(c => (c.phone||'').replace(/[^\d]/g,'').slice(-10) === cleanPhone)
      if (!client) { console.log('No match for:', cleanPhone); return res.json({ ok: true, skipped: 'no match' }) }
      console.log('Matched:', client.first_name)
      await sb.from('messages').insert({ client_id: client.id, sender: 'client', content: text, read: false, created_at: new Date().toISOString() })
      await sb.from('admin_notifications').insert({ type: 'message', title: client.first_name + ' sent a message', body: text.slice(0, 100), client_id: client.id })
      await sendPushToClient(client.id, '💬 New message from ' + client.first_name, text.slice(0, 100))
      return res.json({ ok: true })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => { console.log('UCS webhook running on port', PORT); testConnection() })
