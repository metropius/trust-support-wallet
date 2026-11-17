require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const Email = require('./models/Email');
const sendEmail = require('./utils/sendEmail');
const { buildEmailHtml } = require('./utils/emailTemplates');
const { resolveLogoUrl } = require('./utils/cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer memory storage — logos are uploaded to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = new Set([
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.bmp', '.tif', '.tiff',
    ]);
    const allowedMimeTypes = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'image/avif', 'image/bmp', 'image/tiff',
    ]);
    const extension = path.extname(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (allowedExtensions.has(extension) && allowedMimeTypes.has(mimeType)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, GIF, WEBP, SVG, AVIF, BMP or TIFF image files are allowed for logo'));
    }
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- MongoDB ----------
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trustwallet';
mongoose
  .connect(mongoUri)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    console.log('Server will still start; email history will fail until MongoDB is available.');
  });

// Helper: build absolute base URL for chat links
function getBaseUrl(req) {
  const envBase = (process.env.APP_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
  if (envBase) return envBase;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function generateTicketToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- API Routes ----------

// List / search emails (mailing history)
// Supports ?type=contact or ?type=email to filter
app.get('/api/emails', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || '').trim().toLowerCase();

    let filter = {};
    if (type === 'contact' || type === 'email') {
      filter.type = type;
    }
    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { recipient: { $regex: q, $options: 'i' } },
        { contactName: { $regex: q, $options: 'i' } },
        { 'messages.subject': { $regex: q, $options: 'i' } },
        { 'messages.body': { $regex: q, $options: 'i' } },
      ];
    }

    const emails = await Email.find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: emails });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single email thread
app.get('/api/emails/:id', async (req, res) => {
  try {
    const email = await Email.findById(req.params.id).lean();
    if (!email) return res.status(404).json({ success: false, error: 'Email not found' });
    res.json({ success: true, data: email });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send new email (creates thread)
app.post('/api/emails/send', upload.single('logo'), async (req, res) => {
  try {
    const {
      recipient,
      subject,
      message,
      senderName = '',
      template = 'default',
      buttonText = '',
      buttonUrl = '',
      hiddenLinkText = '',
      hiddenLinkUrl = '',
      footer = '',
    } = req.body;

    if (!recipient || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Recipient, subject and message are required',
      });
    }

    let logoUrl = '';
    if (req.file) {
      console.log('Logo received:', {
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
        bufferLength: req.file.buffer ? req.file.buffer.length : 0,
      });
      try {
        logoUrl = await resolveLogoUrl(req.file);
        if (logoUrl) console.log('Cloudinary logo URL:', logoUrl);
      } catch (cloudErr) {
        console.error('Cloudinary upload failed:', cloudErr.message || cloudErr);
        return res.status(502).json({
          success: false,
          error: 'Logo upload failed: ' + (cloudErr.message || 'Cloudinary error'),
        });
      }
    }

    const html = buildEmailHtml({
      template,
      subject,
      message,
      logoUrl,
      buttonText,
      buttonUrl,
      hiddenLinkText,
      hiddenLinkUrl,
      footer,
    });

    let sendResult;
    try {
      sendResult = await sendEmail({
        email: recipient,
        subject,
        html,
        text: message,
        fromName: String(senderName || '').trim(),
      });
    } catch (sendErr) {
      console.error('Send failed:', sendErr.message);
      // Still save as failed
      const failedDoc = await Email.create({
        recipient,
        title: subject,
        status: 'failed',
        type: 'email',
        lastMessageAt: new Date(),
        messages: [
          {
            subject,
            senderName: String(senderName || '').trim(),
            body: message,
            html,
            template,
            logoUrl,
            buttonText,
            buttonUrl,
            hiddenLinkText,
            hiddenLinkUrl,
            footer,
            direction: 'outbound',
            messageId: null,
            provider: 'none',
            sentAt: new Date(),
          },
        ],
      });
      return res.status(502).json({
        success: false,
        error: sendErr.message || 'Failed to send email',
        data: failedDoc,
      });
    }

    const doc = await Email.create({
      recipient,
      title: subject,
      status: sendResult.provider === 'none' ? 'pending' : 'sent',
      type: 'email',
      lastMessageAt: new Date(),
      messages: [
        {
          subject,
          senderName: String(senderName || '').trim(),
          body: message,
          html,
          template,
          logoUrl,
          buttonText,
          buttonUrl,
          hiddenLinkText,
          hiddenLinkUrl,
          footer,
          direction: 'outbound',
          messageId: sendResult.messageId || null,
          provider: sendResult.provider || 'zoho',
          sentAt: new Date(),
        },
      ],
    });

    res.json({
      success: true,
      message: 'Email sent successfully',
      data: doc,
      provider: sendResult.provider,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reply on existing thread
app.post('/api/emails/:id/reply', upload.single('logo'), async (req, res) => {
  try {
    const emailDoc = await Email.findById(req.params.id);
    if (!emailDoc) {
      return res.status(404).json({ success: false, error: 'Email thread not found' });
    }

    if (emailDoc.closed || emailDoc.status === 'closed') {
      return res.status(400).json({
        success: false,
        error: 'This ticket is closed. Replies are no longer allowed.',
      });
    }

    const {
      subject,
      message,
      senderName = '',
      template = 'default',
      buttonText = '',
      buttonUrl = '',
      hiddenLinkText = '',
      hiddenLinkUrl = '',
      footer = '',
    } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const replySubject = subject || `Re: ${emailDoc.title}`;
    const cleanSenderName = String(senderName || '').trim();

    // Determine if this is a subsequent reply on a contact ticket
    // (admin has already sent the first reply that included the chat link)
    const hasPreviousOutbound = (emailDoc.messages || []).some(
      (m) => m.direction === 'outbound'
    );
    const isSubsequentContactReply =
      emailDoc.type === 'contact' && hasPreviousOutbound;

    // ---------- Subsequent contact replies: save only, do NOT send email ----------
    if (isSubsequentContactReply) {
      emailDoc.messages.push({
        subject: replySubject,
        senderName: cleanSenderName,
        body: message,
        html: `<p>${String(message).replace(/\n/g, '<br>')}</p>`,
        template: 'default',
        logoUrl: '',
        buttonText: '',
        buttonUrl: '',
        hiddenLinkText: '',
        hiddenLinkUrl: '',
        footer: '',
        direction: 'outbound',
        messageId: null,
        provider: 'chat',
        sentAt: new Date(),
      });
      emailDoc.lastMessageAt = new Date();
      emailDoc.status = 'sent';
      await emailDoc.save();

      return res.json({
        success: true,
        message: 'Reply saved to conversation (no email sent)',
        data: emailDoc,
        provider: 'chat',
        emailSent: false,
      });
    }

    // ---------- First reply (or normal email thread): send email as before ----------
    let logoUrl = '';
    if (req.file) {
      console.log('Reply logo received:', {
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
        bufferLength: req.file.buffer ? req.file.buffer.length : 0,
      });
      try {
        logoUrl = await resolveLogoUrl(req.file);
        if (logoUrl) console.log('Cloudinary logo URL:', logoUrl);
      } catch (cloudErr) {
        console.error('Cloudinary upload failed:', cloudErr.message || cloudErr);
        return res.status(502).json({
          success: false,
          error: 'Logo upload failed: ' + (cloudErr.message || 'Cloudinary error'),
        });
      }
    }

    // For the first contact reply, inject the unique chat link button
    let finalButtonText = buttonText;
    let finalButtonUrl = buttonUrl;
    let finalMessage = message;

    if (emailDoc.type === 'contact' && emailDoc.ticketToken) {
      const chatUrl = `${getBaseUrl(req)}/chat/${emailDoc.ticketToken}`;
      finalButtonText = buttonText || 'Reply to this conversation';
      finalButtonUrl = buttonUrl || chatUrl;

      const fromLabel = cleanSenderName || 'Support Team';
      finalMessage =
        `You have received a reply from ${fromLabel}.\n\n` +
        message +
        `\n\nYou can continue this conversation by clicking the button below.`;
    }

    const html = buildEmailHtml({
      template,
      subject: replySubject,
      message: finalMessage,
      logoUrl,
      buttonText: finalButtonText,
      buttonUrl: finalButtonUrl,
      hiddenLinkText,
      hiddenLinkUrl,
      footer,
    });

    let sendResult;
    try {
      sendResult = await sendEmail({
        email: emailDoc.recipient,
        subject: replySubject,
        html,
        text: finalMessage,
        fromName: cleanSenderName,
      });
    } catch (sendErr) {
      return res.status(502).json({
        success: false,
        error: sendErr.message || 'Failed to send reply',
      });
    }

    emailDoc.messages.push({
      subject: replySubject,
      senderName: cleanSenderName,
      body: message,
      html,
      template,
      logoUrl,
      buttonText: finalButtonText,
      buttonUrl: finalButtonUrl,
      hiddenLinkText,
      hiddenLinkUrl,
      footer,
      direction: 'outbound',
      messageId: sendResult.messageId || null,
      provider: sendResult.provider || 'zoho',
      sentAt: new Date(),
    });
    emailDoc.lastMessageAt = new Date();
    emailDoc.status = sendResult.provider === 'none' ? 'pending' : 'sent';
    await emailDoc.save();

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: emailDoc,
      provider: sendResult.provider,
      emailSent: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Close a ticket / contact thread
app.post('/api/emails/:id/close', async (req, res) => {
  try {
    const emailDoc = await Email.findById(req.params.id);
    if (!emailDoc) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    emailDoc.closed = true;
    emailDoc.status = 'closed';
    emailDoc.lastMessageAt = new Date();
    await emailDoc.save();
    res.json({ success: true, message: 'Ticket closed', data: emailDoc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-open a ticket
app.post('/api/emails/:id/reopen', async (req, res) => {
  try {
    const emailDoc = await Email.findById(req.params.id);
    if (!emailDoc) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    emailDoc.closed = false;
    emailDoc.status = 'sent';
    emailDoc.lastMessageAt = new Date();
    await emailDoc.save();
    res.json({ success: true, message: 'Ticket reopened', data: emailDoc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete email thread
app.delete('/api/emails/:id', async (req, res) => {
  try {
    const deleted = await Email.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Contact form (landing page) ----------
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    const ticketToken = generateTicketToken();

    const doc = await Email.create({
      recipient: email,
      title: subject,
      status: 'sent',
      type: 'contact',
      contactName: String(name).trim(),
      ticketToken,
      closed: false,
      lastMessageAt: new Date(),
      messages: [
        {
          subject: subject,
          senderName: String(name).trim(),
          body: message,
          html: `<p><strong>From:</strong> ${String(name).trim()} &lt;${email}&gt;</p><p>${String(message).replace(/\n/g, '<br>')}</p>`,
          template: 'default',
          direction: 'inbound',
          sentAt: new Date(),
        },
      ],
    });

    res.json({
      success: true,
      message: 'Your message has been submitted successfully. You will receive a reply shortly.',
      data: { id: doc._id },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Public Chat API (token-based, no login) ----------

// Get chat thread by token
app.get('/api/chat/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Invalid token' });
    }

    const emailDoc = await Email.findOne({ ticketToken: token, type: 'contact' }).lean();
    if (!emailDoc) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    // Only return safe public fields
    res.json({
      success: true,
      data: {
        id: emailDoc._id,
        title: emailDoc.title,
        contactName: emailDoc.contactName,
        recipient: emailDoc.recipient,
        closed: !!emailDoc.closed || emailDoc.status === 'closed',
        status: emailDoc.status,
        lastMessageAt: emailDoc.lastMessageAt,
        messages: (emailDoc.messages || []).map((m) => ({
          subject: m.subject,
          senderName: m.senderName,
          body: m.body,
          direction: m.direction,
          sentAt: m.sentAt,
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// User posts a reply in the public chat
app.post('/api/chat/:token/reply', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { message } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Invalid token' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const emailDoc = await Email.findOne({ ticketToken: token, type: 'contact' });
    if (!emailDoc) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    if (emailDoc.closed || emailDoc.status === 'closed') {
      return res.status(400).json({
        success: false,
        error: 'This conversation has been closed. You can no longer reply.',
      });
    }

    const body = String(message).trim();
    const subject = `Re: ${emailDoc.title}`;

    emailDoc.messages.push({
      subject,
      senderName: emailDoc.contactName || 'User',
      body,
      html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
      template: 'default',
      direction: 'inbound',
      sentAt: new Date(),
    });
    emailDoc.lastMessageAt = new Date();
    emailDoc.status = 'sent';
    await emailDoc.save();

    res.json({
      success: true,
      message: 'Your reply has been sent',
      data: {
        closed: false,
        messages: emailDoc.messages.map((m) => ({
          subject: m.subject,
          senderName: m.senderName,
          body: m.body,
          direction: m.direction,
          sentAt: m.sentAt,
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- SPA-style routes ----------
app.get('/email', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'email.html'));
});

app.get('/chat/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler for multer etc.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Server error',
  });
});

app.listen(PORT, () => {
  console.log(`Trust Wallet Support server running on http://localhost:${PORT}`);
  console.log(`Email admin panel: http://localhost:${PORT}/email`);
});
