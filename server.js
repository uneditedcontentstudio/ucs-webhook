const express = require('express')
const app = express()
app.use(express.json())

const SUPABASE_URL = 'https://wvnmyvykjdwjctmiltog.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY

async function sbGet(path, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1' + path, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        }
      })
      return res.json()
    } catch (e) {
      console.log(`sbGet attempt ${i+1} failed:`, e.message)
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000))
      else throw e
    }
  }
}

async function sbPost(path, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(SUPABASE_URL + '/rest/v1' + path, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(body)
      })
    } catch (e) {
      console.log(`sbPost attempt ${i+1} failed:`, e.message)
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000))
      else throw e
    }
  }
}

// Test Supabase connection on startup
async function testConnection() {
  try {
    console.log('Testing Supabase connection...')
    const res = await fetch(SUPABASE_URL + '/rest/v1/clients?select=id&limit=1', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    })
    console.log('Supabase connection test:', res.status, res.ok ? 'OK' : 'FAILED')
  } catch (e) {
    console.error('Supabase connection test FAILED:', e.message)
  }
}

app.get('/', (req, res) => res.json({ ok: true, service: 'UCS OpenPhone Webhook' }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received type:', body?.type || body?.action)

  try {
    if (body?.action === 'send') {
      const { to, message } = body
      console.log('Sending SMS to:', to)
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: { 'Authorization': OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message, from: 'PN7bGOiGL0', to: [to] })
      })
      const data = await response.json()
      console.log('OpenPhone response:', response.status, JSON.stringify(data))
      return res.json({ ok: response.ok, data })
    }

    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || ''
      if (!from || !text) return res.json({ ok: true, skipped: 'no from/text' })
      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)
      console.log('Inbound from:', cleanPhone, 'text:', text)

      const clients = await sbGet('/clients?select=id,first_name,phone&limit=200')
      console.log('Clients fetched:', Array.isArray(clients) ? clients.length : JSON.stringify(clients))

      const client = (Array.isArray(clients) ? clients : []).find(c => {
        const cp = (c.phone || '').replace(/[^\d]/g, '').slice(-10)
        return cp && cp === cleanPhone
      })

      if (!client) {
        console.log('No match for:', cleanPhone)
        return res.json({ ok: true, skipped: 'no client match' })
      }

      console.log('Matched:', client.first_name)
      await sbPost('/messages', { client_id: client.id, sender: 'client', content: text, read: false, created_at: new Date().toISOString() })
      await sbPost('/admin_notifications', { type: 'message', title: client.first_name + ' sent a message', body: text.slice(0, 100), client_id: client.id })
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
