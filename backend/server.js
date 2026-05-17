import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import { OpenAI } from 'openai';
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ storage: multer.memoryStorage() });

// OpenAI Client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// System Prompt (Critical Rules Injected)
const SYSTEM_PROMPT = `أنت "مساعد نخبة الأشعة"، نظام ذكاء اصطناعي متخصص في تدريس الأشعة لطلاب الجامعة.

**القاعدة 1 (حرجة جداً):** إذا قال المستخدم أي تحية (مثل "مرحبا"، "هلو"، "السلام عليكم") أو سأل عن هويتك أو من صنعك (مثل "من أنت"، "من صنعك")، يجب عليك الرد بالضبط والحرف الواحد بالنص التالي فقط، بدون أي إضافة أو تعديل:

"أهلاً بك 🌟
أنا نظام ذكاء اصطناعي صُممت وطُورت من قبل الطالب محمد جبار إبراهيم، تحت إشراف رئاسة قسم تقنيات الأشعة والسونار، وبإشراف مباشر من الدكتور سامي محمد رئيس القسم، والدكتور مصطفى مقرر القسم، لأكون منصة ذكية تساعد الطلبة وتدعم الجانب العلمي والتقني بأساليب حديثة ومتطورة."

**القاعدة 2:** لجميع الأسئلة الطبية والأشعاعية، قدم إجابات دقيقة وعلمية وأكاديمية على أعلى مستوى. ادمج الشرح بالعربية السلسة مع المصطلحات الطبية الإنجليزية الدقيقة مباشرة (مثل: AP/PA/Lateral، CT/MRI protocols، kVp، mAs، radiographic parameters). استند إلى معايير الأشعة العالمية.

كن ودياً وسهل التفاهم مع الطلاب، واشرح المفاهيم المعقدة بطريقة تعليمية واضحة.`;

// ============ TEXT CHAT API ============
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: 'OpenAI API key not configured' });
        }

        // Build conversation history
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(history || []),
            { role: 'user', content: message }
        ];

        // Call OpenAI with gpt-4o-mini (cost-optimized)
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: 1024,
            top_p: 0.9
        });

        const aiReply = response.choices[0]?.message?.content || 'عذراً، لم أستطع فهم السؤال.';

        // Generate TTS audio
        let audioBase64 = null;
        try {
            const audioResponse = await openai.audio.speech.create({
                model: 'tts-1',
                voice: 'shimmer',
                input: aiReply,
                speed: 1.0
            });

            const buffer = await audioResponse.arrayBuffer();
            audioBase64 = Buffer.from(buffer).toString('base64');
        } catch (ttsError) {
            console.warn('⚠️ TTS generation failed:', ttsError.message);
            // Continue without audio
        }

        res.json({
            reply: aiReply,
            audio: audioBase64,
            tokensUsed: response.usage?.total_tokens || 0
        });

    } catch (error) {
        console.error('❌ Chat error:', error.message);
        res.status(500).json({ 
            error: 'خطأ في معالجة الطلب',
            details: error.message 
        });
    }
});

// ============ VOICE API (STT + TTS) ============
app.post('/api/voice', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        const { history } = req.body;

        // Step 1: Speech-to-Text (STT)
        let transcription = '';
        try {
            const audioBlob = new File([req.file.buffer], 'audio.wav', { type: 'audio/wav' });
            
            const transcriptionResponse = await openai.audio.transcriptions.create({
                file: audioBlob,
                model: 'whisper-1',
                language: 'ar'
            });

            transcription = transcriptionResponse.text || '';
        } catch (sttError) {
            console.error('❌ STT error:', sttError.message);
            return res.status(500).json({ error: 'Failed to transcribe audio' });
        }

        if (!transcription.trim()) {
            return res.status(400).json({ error: 'No speech detected' });
        }

        // Step 2: Send to AI
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(history ? JSON.parse(history) : []),
            { role: 'user', content: transcription }
        ];

        const chatResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: 1024
        });

        const aiReply = chatResponse.choices[0]?.message?.content || 'عذراً، لم أتمكن من الرد.';

        // Step 3: Text-to-Speech (TTS)
        let audioBase64 = null;
        try {
            const audioResponse = await openai.audio.speech.create({
                model: 'tts-1',
                voice: 'shimmer',
                input: aiReply,
                speed: 1.0
            });

            const buffer = await audioResponse.arrayBuffer();
            audioBase64 = Buffer.from(buffer).toString('base64');
        } catch (ttsError) {
            console.warn('⚠️ TTS generation failed:', ttsError.message);
        }

        res.json({
            transcription,
            reply: aiReply,
            audio: audioBase64,
            tokensUsed: chatResponse.usage?.total_tokens || 0
        });

    } catch (error) {
        console.error('❌ Voice API error:', error.message);
        res.status(500).json({ 
            error: 'خطأ في معالجة الصوت',
            details: error.message 
        });
    }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    const status = {
        status: 'online',
        timestamp: new Date().toISOString(),
        apiConfigured: !!process.env.OPENAI_API_KEY,
        port: PORT
    };
    res.json(status);
});

// ============ ROOT ROUTE ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║  🏥 مساعد نخبة الأشعة                   ║
║  Radiology Elite Assistant             ║
╚════════════════════════════════════════╝

✅ Server running on port ${PORT}
🌐 URL: http://localhost:${PORT}
🔐 API Key: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing'}
🤖 Model: gpt-4o-mini (cost-optimized)
📱 PWA: Enabled
🎤 Voice: STT + TTS Active
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Server shutting down...');
    process.exit(0);
});
