const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY

console.log('SUPABASE_URL:', SUPABASE_URL ? 'set' : 'MISSING')
console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'set (' + SUPABASE_KEY.length + ' chars)' : 'MISSING')
console.log('OPENPHONE_API_KEY:', OPENPHONE_API_KEY ? 'set' : 'MISSING')

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function testConnection() {
  try {
    const { data, error } = await sb.from('clients').select('id').limit(1)
    if (error) console.log('Supabase test error:', error.message)
    else console.log('Supabase connection test: OK, clients found:', data?.length)
  } catch (e) {
    console.error('Supabase test exception:', e.message)
  }
}

app.get('/', (req, res) => res.json({ ok: true, service: 'UCS OpenPhone Webhook' }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received type:', body?.type || body?.action)

  try {
    // ── OUTBOUND: send SMS from portal ──
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

    // ── INBOUND: message from OpenPhone webhook ──
    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || ''
      if (!from || !text) return res.json({ ok: true, skipped: 'no from/text' })

      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)
      console.log('Inbound from:', cleanPhone)

      const { data: clients, error: clientErr } = await sb.from('clients').select('id,first_name,phone').limit(200)
      if (clientErr) { console.log('Client fetch error:', clientErr.message); return res.json({ ok: true, skipped: 'db error' }) }
      console.log('Clients fetched:', clients?.length)

      const client = (clients || []).find(c => {
        const cp = (c.phone || '').replace(/[^\d]/g, '').slice(-10)
        return cp && cp === cleanPhone
      })

      if (!client) {
        console.log('No match for:', cleanPhone)
        return res.json({ ok: true, skipped: 'no client match' })
      }

      console.log('Matched:', client.first_name)

      await sb.from('messages').insert({ client_id: client.id, sender: 'client', content: text, read: false, created_at: new Date().toISOString() })
      await sb.from('admin_notifications').insert({ type: 'message', title: client.first_name + ' sent a message', body: text.slice(0, 100), client_id: client.id })

      console.log('Saved message for', client.first_name)
      return res.json({ ok: true })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('UCS webhook running on port', PORT)
  testConnection()
})
