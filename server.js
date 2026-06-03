const express = require('express')
const app = express()
app.use(express.json())

const SUPABASE_URL = 'https://wvnmyvykjdwjctmiltog.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY

async function supabase(path, method='GET', body=null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method==='POST' ? 'return=minimal' : ''
    }
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, opts)
  if (method === 'GET') return res.json()
  return res
}

// Health check — OpenPhone validates with GET
app.get('/', (req, res) => res.json({ ok: true, service: 'UCS OpenPhone Webhook' }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

// Main webhook handler
app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received:', JSON.stringify(body))

  try {
    // ── OUTBOUND: send SMS from portal ──
    if (body?.action === 'send') {
      const { to, message } = body
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': OPENPHONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: message, from: 'PN7bGOiGL0', to: [to] })
      })
      const data = await response.json()
      console.log('OpenPhone response:', JSON.stringify(data))
      return res.json({ ok: response.ok, data })
    }

    // ── INBOUND: message received from client via OpenPhone ──
    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || msg?.content || ''

      if (!from || !text) return res.json({ ok: true, skipped: 'no from/text' })

      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)

      // Find matching client by phone
      const clients = await supabase('/clients?select=id,first_name,phone')
      const client = (clients || []).find(c => {
        const cp = (c.phone || '').replace(/[^\d]/g, '').slice(-10)
        return cp && cp === cleanPhone
      })

      if (!client) {
        console.log('No client found for phone:', cleanPhone)
        return res.json({ ok: true, skipped: 'no client match' })
      }

      // Insert message
      await supabase('/messages', 'POST', {
        client_id: client.id,
        sender: 'client',
        content: text,
        read: false,
        created_at: new Date().toISOString()
      })

      // Admin notification
      await supabase('/admin_notifications', 'POST', {
        type: 'message',
        title: client.first_name + ' sent a message',
        body: text.slice(0, 100),
        client_id: client.id
      })

      console.log('Message saved for', client.first_name)
      return res.json({ ok: true })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error:', e)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('UCS webhook server running on port', PORT))
