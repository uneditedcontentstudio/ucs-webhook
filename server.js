const express = require('express')
const app = express()
app.use(express.json())

// Use IPv4-compatible Supabase REST endpoint
const SUPABASE_REST = 'https://wvnmyvykjdwjctmiltog.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY

async function sbGet(path) {
  const res = await fetch(SUPABASE_REST + '/rest/v1' + path, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    }
  })
  return res.json()
}

async function sbPost(path, body) {
  return fetch(SUPABASE_REST + '/rest/v1' + path, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  })
}

app.get('/', (req, res) => res.json({ ok: true, service: 'UCS OpenPhone Webhook' }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received type:', body?.type || body?.action)

  try {
    // ── OUTBOUND: send SMS from portal ──
    if (body?.action === 'send') {
      const { to, message } = body
      console.log('Sending SMS to:', to)
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': OPENPHONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: message, from: 'PN7bGOiGL0', to: [to] })
      })
      const data = await response.json()
      console.log('OpenPhone response:', response.status, JSON.stringify(data))
      return res.json({ ok: response.ok, data })
    }

    // ── INBOUND: message from OpenPhone webhook ──
    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || ''

      console.log('Inbound from:', from, 'text:', text)
      if (!from || !text) return res.json({ ok: true, skipped: 'no from/text' })

      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)
      console.log('Clean phone:', cleanPhone)

      const clients = await sbGet('/clients?select=id,first_name,phone&limit=200')
      console.log('Clients count:', Array.isArray(clients) ? clients.length : 'error', typeof clients === 'object' && !Array.isArray(clients) ? JSON.stringify(clients) : '')

      const client = (Array.isArray(clients) ? clients : []).find(c => {
        const cp = (c.phone || '').replace(/[^\d]/g, '').slice(-10)
        return cp && cp === cleanPhone
      })

      if (!client) {
        console.log('No match for:', cleanPhone, 'available:', (Array.isArray(clients) ? clients : []).map(c => (c.phone||'').replace(/[^\d]/g,'').slice(-10)).join(', '))
        return res.json({ ok: true, skipped: 'no client match' })
      }

      console.log('Matched client:', client.first_name)

      await sbPost('/messages', {
        client_id: client.id,
        sender: 'client',
        content: text,
        read: false,
        created_at: new Date().toISOString()
      })

      await sbPost('/admin_notifications', {
        type: 'message',
        title: client.first_name + ' sent a message',
        body: text.slice(0, 100),
        client_id: client.id
      })

      console.log('Saved message for', client.first_name)
      return res.json({ ok: true })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error:', e.message, e.cause?.message || '')
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('UCS webhook running on port', PORT))
