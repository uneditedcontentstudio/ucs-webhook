const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const webpush = require('web-push')
const { google } = require('googleapis')

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
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'chrisna.hang@gmail.com'
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT

const RESEND_KEY = process.env.RESEND_API_KEY
console.log('SUPABASE_URL:', SUPABASE_URL ? 'set' : 'MISSING')
console.log('RESEND:', RESEND_KEY ? 'set' : 'MISSING')
console.log('SUPABASE_KEY:', SUPABASE_KEY ? 'set' : 'MISSING')
console.log('OPENPHONE_API_KEY:', OPENPHONE_API_KEY ? 'set' : 'MISSING')
console.log('VAPID keys:', VAPID_PUBLIC ? 'set' : 'MISSING')
console.log('GOOGLE_SERVICE_ACCOUNT:', GOOGLE_SERVICE_ACCOUNT ? 'set' : 'MISSING')

if(VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:info@uneditedcontentstudio.com', VAPID_PUBLIC, VAPID_PRIVATE)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: require('ws') } })

// Google Drive helper
async function getDriveAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT) return null
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT)
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  })
  return auth
}

// Serve full image file from Drive
app.get('/drive/image/:fileId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType,name' })
    const mimeType = meta.data.mimeType || 'image/jpeg'
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    const stream = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media' },
      { responseType: 'stream' }
    )
    stream.data.pipe(res)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── VIDEO PROCESSING ──
const ffmpeg = require('fluent-ffmpeg')
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
const os = require('os')
const path = require('path')
const fs = require('fs')
ffmpeg.setFfmpegPath(ffmpegInstaller.path)

// Font configs for caption styles
const FONT_CONFIGS = {
  clean: { fontsize: 36, fontcolor: 'white', borderw: 2, bordercolor: 'black', shadowx: 0, shadowy: 0 },
  bold: { fontsize: 42, fontcolor: 'white', borderw: 4, bordercolor: 'black', shadowx: 3, shadowy: 3 },
  subtitle: { fontsize: 32, fontcolor: 'white', borderw: 1, bordercolor: 'black', box: 1, boxcolor: 'black@0.5', boxborderw: 8 },
  glow: { fontsize: 36, fontcolor: 'white', borderw: 0, shadowx: 0, shadowy: 0, shadowcolor: 'white@0.8' }
}

const POSITION_CONFIGS = {
  top: { y: 60 },
  center: { y: '(h-text_h)/2' },
  bottom: { y: 'h-text_h-60' }
}

app.post('/video/process', async (req, res) => {
  const { fileId, trimStart, trimEnd, removesilence, caption, fontStyle, textAlign, fontSize, position, speed } = req.body
  if (!fileId) return res.json({ ok: false, error: 'No fileId' })

  const tmpDir = os.tmpdir()
  const inputPath = path.join(tmpDir, `ucs_in_${fileId}.mp4`)
  const outputPath = path.join(tmpDir, `ucs_out_${fileId}_${Date.now()}.mp4`)

  try {
    console.log('Processing video:', fileId)
    const auth = await getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })

    // Check file size first — warn if over 500MB
    const meta = await drive.files.get({ fileId, fields: 'size,name,mimeType' })
    const fileSize = parseInt(meta.data.size || '0')
    console.log(`File: ${meta.data.name}, Size: ${(fileSize/1024/1024).toFixed(1)}MB`)
    if (fileSize > 800 * 1024 * 1024) {
      return res.json({ ok: false, error: `File too large (${(fileSize/1024/1024).toFixed(0)}MB). Please use a clip under 800MB.` })
    }

    // Download from Drive
    const stream = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    )
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(inputPath)
      stream.data.pipe(writer)
      writer.on('finish', resolve)
      writer.on('error', reject)
    })
    console.log('Downloaded input file')

    // Build FFmpeg command
    let cmd = ffmpeg(inputPath)

    // Trim
    if (trimStart !== undefined && trimStart !== null) cmd = cmd.setStartTime(trimStart)
    if (trimEnd !== undefined && trimEnd !== null) cmd = cmd.setDuration(trimEnd - (trimStart || 0))

    const spd = parseFloat(speed) || 1
    const videoFilters = []
    const audioFilters = []

    // Speed
    if (spd !== 1) {
      videoFilters.push(`setpts=${(1/spd).toFixed(3)}*PTS`)
      // atempo only supports 0.5-2.0, chain for values outside range
      if (spd <= 2) {
        audioFilters.push(`atempo=${spd}`)
      } else {
        audioFilters.push(`atempo=2.0`)
        audioFilters.push(`atempo=${(spd/2).toFixed(2)}`)
      }
    }

    // Remove silence
    if (removesilence) {
      audioFilters.push('silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-50dB')
    }

    // Caption overlay
    if (caption && caption.trim()) {
      const font = FONT_CONFIGS[fontStyle] || FONT_CONFIGS.clean
      const pos = POSITION_CONFIGS[position] || POSITION_CONFIGS.bottom
      const fsizeMap = { small: 28, medium: 36, large: 44, xlarge: 54 }
      const fsize = fsizeMap[fontSize] || font.fontsize
      const alignX = textAlign === 'left' ? '20' :
                     textAlign === 'right' ? 'w-text_w-20' :
                     '(w-text_w)/2'
      const escapedCaption = caption
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\u2019')
        .replace(/:/g, '\\:')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\n/g, ' ')
        .slice(0, 100)

      // Find available font on Railway
      const possibleFonts = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
      ]
      let fontFile = null
      for (const f of possibleFonts) {
        if (fs.existsSync(f)) { fontFile = f; break }
      }

      const parts = [
        `text='${escapedCaption}'`,
        `fontsize=${fsize}`,
        `fontcolor=${font.fontcolor}`,
        `borderw=${font.borderw || 2}`,
        `bordercolor=${font.bordercolor || 'black'}`,
        fontFile ? `fontfile=${fontFile}` : null,
        font.box ? `box=1:boxcolor=${font.boxcolor}:boxborderw=${font.boxborderw}` : null,
        `x=${alignX}`,
        `y=${pos.y}`
      ].filter(Boolean).join(':')

      videoFilters.push(`drawtext=${parts}`)
    }

    if (videoFilters.length > 0) cmd = cmd.videoFilters(videoFilters)
    if (audioFilters.length > 0) cmd = cmd.audioFilters(audioFilters)

    // Output — handle HEVC/HDR iPhone footage + ignore extra streams
    await new Promise((resolve, reject) => {
      cmd
        .outputOptions([
          '-map 0:v:0',
          '-map 0:a:1?',  // use AAC stream (stream 1), not the Apple Lossless stream 2
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-pix_fmt yuv420p',  // convert HDR 10-bit to standard 8-bit for compatibility
          '-vf scale=iw:ih',   // ensure proper scaling
          '-c:a aac',
          '-ac 2',             // stereo output
          '-movflags +faststart',
          '-avoid_negative_ts make_zero'
        ])
        .output(outputPath)
        .on('start', c => console.log('FFmpeg started'))
        .on('progress', p => console.log('Progress:', Math.round(p.percent || 0) + '%'))
        .on('end', resolve)
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message)
          console.error('FFmpeg stderr:', stderr)
          reject(err)
        })
        .run()
    })

    console.log('FFmpeg done, uploading to Supabase')

    // Upload to Supabase storage
    const fileBuffer = fs.readFileSync(outputPath)
    const fileName = `edited/${fileId}_${Date.now()}.mp4`
    const { data: uploadData, error: uploadError } = await sb.storage
      .from('ucs-uploads')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true })

    if (uploadError) throw new Error('Upload failed: ' + uploadError.message)

    const { data: urlData } = await sb.storage
      .from('ucs-uploads')
      .createSignedUrl(fileName, 86400)

    try { fs.unlinkSync(inputPath); fs.unlinkSync(outputPath) } catch(e) {}

    res.json({ ok: true, url: urlData.signedUrl, fileName })
  } catch (e) {
    console.error('Processing error:', e.message)
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath) } catch(e2) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch(e2) {}
    res.json({ ok: false, error: e.message })
  }
})

// Get video metadata (duration etc) for trim UI
app.get('/video/meta/:fileId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType,size,name,videoMediaMetadata' })
    const videoMeta = meta.data.videoMediaMetadata || {}
    res.json({
      ok: true,
      name: meta.data.name,
      size: meta.data.size,
      duration: videoMeta.durationMillis ? videoMeta.durationMillis / 1000 : null,
      width: videoMeta.width,
      height: videoMeta.height
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// Proxy Drive thumbnail (avoids auth issues in browser)
app.get('/drive/thumb/:fileId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const file = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'thumbnailLink,mimeType'
    })
    if (!file.data.thumbnailLink) return res.status(404).send('No thumbnail')
    // Fetch thumbnail and proxy it
    const https = require('https')
    https.get(file.data.thumbnailLink, (imgRes) => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      imgRes.pipe(res)
    }).on('error', () => res.status(500).send('Fetch failed'))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Stream video file from Drive
app.get('/drive/stream/:fileId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType,size,name' })
    const mimeType = meta.data.mimeType || 'video/mp4'
    const fileSize = parseInt(meta.data.size || '0')
    const fileName = meta.data.name || 'video'
    const range = req.headers.range

    if (range && fileSize > 0) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', chunkSize)
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      res.status(206)
      const stream = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      )
      stream.data.pipe(res)
    } else {
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      if (fileSize > 0) res.setHeader('Content-Length', fileSize)
      const stream = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream' }
      )
      stream.data.pipe(res)
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// List month folders inside a client root folder
app.get('/drive/folders/:folderId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    if (!auth) return res.json({ ok: false, error: 'No service account' })
    const drive = google.drive({ version: 'v3', auth })
    const { folderId } = req.params

    const result = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name,createdTime)',
      orderBy: 'name desc',
      pageSize: 100
    })

    const folders = result.data.files || []

    // For each folder get first image for cover thumbnail
    const foldersWithCovers = await Promise.all(folders.map(async (f) => {
      let coverThumb = null
      try {
        // First look for a file named "cover" (cover.jpg, cover.png etc)
        const coverFile = await drive.files.list({
          q: `'${f.id}' in parents and name contains 'cover' and mimeType contains 'image/' and trashed=false`,
          fields: 'files(id)',
          pageSize: 1
        })
        if (coverFile.data.files && coverFile.data.files.length > 0) {
          coverThumb = `/drive/thumb/${coverFile.data.files[0].id}`
        } else {
          // Fall back to first image in folder
          const firstImg = await drive.files.list({
            q: `'${f.id}' in parents and mimeType contains 'image/' and trashed=false`,
            fields: 'files(id)',
            pageSize: 1,
            orderBy: 'name'
          })
          if (firstImg.data.files && firstImg.data.files.length > 0) {
            coverThumb = `/drive/thumb/${firstImg.data.files[0].id}`
          }
        }
      } catch (e) {}
      return {
        id: f.id,
        name: f.name,
        url: 'https://drive.google.com/drive/folders/' + f.id,
        month: parseMonthFromFolderName(f.name),
        coverThumb
      }
    }))

    res.json({ ok: true, folders: foldersWithCovers })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// List video/photo files inside a month folder
app.get('/drive/files/:folderId', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    if (!auth) return res.json({ ok: false, error: 'No service account' })
    const drive = google.drive({ version: 'v3', auth })
    const { folderId } = req.params

    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (mimeType contains 'video/' or mimeType contains 'image/')`,
      fields: 'files(id,name,mimeType,size,thumbnailLink,webViewLink,webContentLink)',
      orderBy: 'name',
      pageSize: 200
    })

    const files = (result.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      type: f.mimeType.startsWith('video/') ? 'video' : 'image',
      size: f.size,
      thumbnail: `/drive/thumb/${f.id}`,
      imageUrl: `/drive/image/${f.id}`,
      streamUrl: `/drive/stream/${f.id}`,
      viewUrl: f.webViewLink,
      downloadUrl: `/drive/stream/${f.id}`
    }))

    res.json({ ok: true, files })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// Helper to parse month from folder name like "JUNE-25 (DELETE 09.15.25)"
function parseMonthFromFolderName(name) {
  const MONTHS = {
    JAN:'January',FEB:'February',MAR:'March',APR:'April',MAY:'May',JUN:'June',
    JUNE:'June',JULY:'July',JUL:'July',AUG:'August',SEP:'September',SEPT:'September',
    OCT:'October',NOV:'November',DEC:'December'
  }
  const part = name.split(' ')[0] // e.g. "JUNE-25"
  const pieces = part.split('-')
  if (pieces.length < 2) return name
  const monthStr = pieces[0].toUpperCase()
  const yearStr = pieces[1]
  const monthName = MONTHS[monthStr] || monthStr
  const year = parseInt(yearStr) < 100 ? 2000 + parseInt(yearStr) : parseInt(yearStr)
  return monthName + ' ' + year
}

// List all client folders from root Drive folder
app.get('/drive/clients', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    if (!auth) return res.json({ ok: false, error: 'No service account' })
    const drive = google.drive({ version: 'v3', auth })
    
    // List all folders shared with service account
    const allFolders = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id,name,parents)',
      pageSize: 200
    })
    
    const folders = allFolders.data.files || []
    console.log('All accessible folders:', folders.map(f => f.name))
    
    // Find client folders (contain - MCM)
    const clients = folders
      .filter(f => f.name.includes(' - MCM'))
      .map(f => ({
        name: f.name.replace(' - MCM', '').trim(),
        folder_id: f.id,
        url: 'https://drive.google.com/drive/folders/' + f.id
      }))
    
    res.json({ ok: true, clients, all_folders: folders.map(f => f.name) })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// Drive test endpoint
app.get('/drive-test', async (req, res) => {
  try {
    const auth = await getDriveAuth()
    if (!auth) return res.json({ ok: false, error: 'No service account configured' })
    const drive = google.drive({ version: 'v3', auth })
    // Try to list root files
    const result = await drive.files.list({
      pageSize: 5,
      fields: 'files(id, name, mimeType)'
    })
    res.json({ ok: true, files: result.data.files, count: result.data.files.length })
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code })
  }
})

// Google Calendar helper
async function createCalendarEvent({ summary, description, date, startTime, endTime, clientEmail }) {
  if (!GOOGLE_SERVICE_ACCOUNT) { console.log('No Google service account configured'); return null }
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT)
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/calendar']
    })
    const calendar = google.calendar({ version: 'v3', auth })
    
    // Build event times
    const start = startTime 
      ? { dateTime: `${date}T${startTime}:00`, timeZone: 'America/Boise' }
      : { date }
    const end = endTime
      ? { dateTime: `${date}T${endTime}:00`, timeZone: 'America/Boise' }
      : startTime
        ? { dateTime: `${date}T${startTime.split(':')[0]}:${startTime.split(':')[1] || '00'}:00`, timeZone: 'America/Boise' }
        : { date }

    const event = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      sendUpdates: 'none',
      requestBody: {
        summary,
        description,
        start,
        end
      }
    })
    console.log('Calendar event created:', event.data.id)
    return event.data
  } catch(e) {
    console.error('Calendar event error:', e.message)
    return null
  }
}

async function sendPushToClient(clientId, title, body, type) {
  try {
    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('client_id', clientId)
    if (!subs || subs.length === 0) { console.log('No push subscriptions for client:', clientId); return }
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, type: type||'home', icon: '/icon-192.png', badge: '/icon-192.png' }))
        console.log('Push sent to', clientId)
      } catch(e) {
        console.log('Push failed:', e.statusCode, e.message)
        if(e.statusCode === 410 || e.statusCode === 404) {
          await sb.from('push_subscriptions').delete().eq('id', sub.id)
        }
      }
    }
  } catch(e) { console.error('sendPushToClient error:', e.message) }
}

async function testConnection() {
  try {
    const { data, error } = await sb.from('clients').select('id').limit(1)
    if (error) console.log('Supabase error:', error.message)
    else console.log('Supabase OK, clients:', data?.length)
  } catch (e) { console.error('Supabase exception:', e.message) }
}

app.get('/', (req, res) => res.json({ ok: true, service: 'UCS Webhook' }))
app.get('/webhook', (req, res) => res.json({ ok: true }))

app.post('/webhook', async (req, res) => {
  const body = req.body
  console.log('Received type:', body?.type || body?.action)

  try {
    // ── SAVE PUSH SUBSCRIPTION ──
    if (body?.action === 'subscribe') {
      const { client_id, subscription } = body
      if (!client_id || !subscription) return res.json({ ok: false, error: 'missing fields' })
      await sb.from('push_subscriptions').upsert({ client_id, subscription, endpoint: subscription.endpoint, updated_at: new Date().toISOString() }, { onConflict: 'client_id,endpoint' })
      console.log('Push subscription saved for:', client_id)
      return res.json({ ok: true })
    }

    // ── SEND PUSH ──
    if (body?.action === 'push') {
      const { client_id, title, body: msg, type } = body
      await sendPushToClient(client_id, title, msg, type)
      return res.json({ ok: true })
    }

    if (body?.action === 'email') {
      const { to, subject, html } = body
      if (!RESEND_KEY) return res.json({ ok: false, error: 'Resend not configured' })
      try {
        const res2 = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Unedited Content Studio <onboarding@resend.dev>', to, subject, html })
        })
        const data = await res2.json()
        if (!res2.ok) { console.error('Resend error:', data); return res.json({ ok: false, error: data }) }
        console.log('Email sent to', to)
        return res.json({ ok: true })
      } catch(e) {
        console.error('Email error:', e.message)
        return res.json({ ok: false, error: e.message })
      }
    }

    // ── CREATE CALENDAR EVENT ──
    if (body?.action === 'calendar') {
      const { summary, description, date, startTime, endTime, clientEmail } = body
      const event = await createCalendarEvent({ summary, description, date, startTime, endTime, clientEmail })
      return res.json({ ok: !!event, eventId: event?.id, event })
    }

    if (body?.action === 'calendar_delete') {
      const { eventId } = body
      if (!eventId || !GOOGLE_SERVICE_ACCOUNT) return res.json({ ok: false })
      try {
        const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT)
        const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/calendar'] })
        const calendar = google.calendar({ version: 'v3', auth })
        await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId })
        console.log('Calendar event deleted:', eventId)
        return res.json({ ok: true })
      } catch(e) {
        console.error('Calendar delete error:', e.message)
        return res.json({ ok: false, error: e.message })
      }
    }

    // ── OUTBOUND SMS ──
    if (body?.action === 'send') {
      let { to, message, mediaUrl } = body
      if (to && !to.startsWith('+')) to = '+1' + to.replace(/[^\d]/g, '')
      console.log('Sending SMS/MMS to:', to, mediaUrl ? '(with image)' : '')
      const payload = { from: 'PN7bGOiGL0', to: [to] }
      payload.content = (message && message.trim()) ? message.trim() : null
      // OpenPhone API doesn't support MMS - send image as a link instead
      if (mediaUrl && !payload.content) payload.content = '📷 Photo: ' + mediaUrl
      else if (mediaUrl) payload.content = payload.content + '\n📷 ' + mediaUrl
      if (!payload.content) { console.log('No content to send'); return res.json({ ok: false, error: 'no content' }) }
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: { 'Authorization': OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await response.json()
      console.log('OpenPhone response:', response.status, JSON.stringify(data))
      return res.json({ ok: response.ok, data })
    }

    // ── INBOUND SMS / MMS ──
    if (body?.type === 'message.received') {
      const msg = body?.data?.object
      const from = msg?.from
      const text = msg?.body || ''
      // Get media attachments if any (MMS)
      const media = msg?.media || []
      const firstImageUrl = media.length > 0 ? media[0]?.url : null
      // Skip if no text AND no media
      if (!from || (!text && !firstImageUrl)) return res.json({ ok: true, skipped: 'no from/text/media' })
      const cleanPhone = from.replace(/[^\d]/g, '').slice(-10)
      console.log('Inbound from:', cleanPhone, firstImageUrl ? '(with image)' : '')
      const { data: clients } = await sb.from('clients').select('id,first_name,phone').limit(200)
      const client = (clients || []).find(c => (c.phone||'').replace(/[^\d]/g,'').slice(-10) === cleanPhone)
      if (!client) { console.log('No match for:', cleanPhone); return res.json({ ok: true, skipped: 'no match' }) }
      console.log('Matched:', client.first_name)
      // Save message with image_url if present
      const msgRow = { client_id: client.id, sender: 'client', content: text, read: false, created_at: new Date().toISOString() }
      if (firstImageUrl) msgRow.image_url = firstImageUrl
      await sb.from('messages').insert(msgRow)
      const notifBody = firstImageUrl ? (text || '📷 Photo') : text.slice(0, 100)
      await sb.from('admin_notifications').insert({ type: 'message', title: client.first_name + ' sent a message', body: notifBody, client_id: client.id })
      await sendPushToClient(client.id, '💬 New message from ' + client.first_name, notifBody, 'message')
      return res.json({ ok: true })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => { console.log('UCS webhook running on port', PORT); testConnection(); startCron() })

function fmtTime12(t){
  const parts = t.split(':')
  let h = parseInt(parts[0])
  const m = parts[1] || '00'
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return h + (m !== '00' ? ':' + m : '') + ' ' + ap
}

async function sendDayBeforeReminders(){
  try {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().slice(0, 10)
    console.log('Checking sessions for:', tomorrowStr)

    const { data: sessions } = await sb
      .from('sessions')
      .select('id, client_id, session_date, start_time, reminder_sent, clients(first_name, phone, id)')
      .eq('session_date', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('deleted', false)
      .eq('reminder_sent', false)

    if (!sessions || sessions.length === 0) {
      console.log('No sessions to remind for', tomorrowStr)
      return
    }

    console.log('Sending reminders for', sessions.length, 'session(s)')

    for (const session of sessions) {
      const cl = session.clients
      if (!cl) continue

      const timeStr = session.start_time ? ' at ' + fmtTime12(session.start_time) : ''
      const msg = 'Hi ' + cl.first_name + '! Just a reminder that your filming session is tomorrow' + timeStr + '. Open your portal to confirm your attendance or text us if you need to reschedule.'

      // Send SMS
      if (cl.phone) {
        let phone = cl.phone.replace(/[^\d+]/g, '')
        if (!phone.startsWith('+')) phone = '+1' + phone
        try {
          await fetch('https://api.openphone.com/v1/messages', {
            method: 'POST',
            headers: { 'Authorization': OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: msg, from: 'PN7bGOiGL0', to: [phone] })
          })
          console.log('Reminder SMS sent to', cl.first_name)
        } catch(e) { console.log('SMS error:', e.message) }
      }

      // Send push notification
      await sendPushToClient(cl.id, 'Session reminder 📅', 'Your filming session is tomorrow' + timeStr + '. Tap to confirm your attendance.', 'booking')

      // Portal message
      await sb.from('messages').insert({
        client_id: cl.id,
        sender: 'admin',
        content: msg,
        read: false,
        created_at: new Date().toISOString()
      })

      // Mark reminder sent
      await sb.from('sessions').update({ reminder_sent: true }).eq('id', session.id)
      console.log('Reminder sent for', cl.first_name, 'session on', tomorrowStr)
    }
  } catch(e) {
    console.error('Reminder cron error:', e.message)
  }
}

function startCron(){
  setInterval(async function(){
    const now = new Date()
    const mountain = new Date(now.toLocaleString('en-US', { timeZone: 'America/Boise' }))
    const hour = mountain.getHours()
    const min = mountain.getMinutes()
    if(hour === 9 && min < 5){
      console.log('Running 9AM reminder job...')
      await sendDayBeforeReminders()
    }
  }, 5 * 60 * 1000)
  console.log('Cron started — checks every 5 min for 9AM reminders')
}
