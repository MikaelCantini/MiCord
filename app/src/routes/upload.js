const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const authMiddleware = require('../middleware/authMiddleware');

// Garante que a pasta de uploads exista
if (!fs.existsSync(config.UPLOAD_DIR)) {
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `file-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        // Aceita imagens, pdf, audios, videos, documentos de texto e zip
        cb(null, true);
    }
});

router.post('/', authMiddleware, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const isImage = req.file.mimetype.startsWith('image/');
        const fileUrl = `/uploads/${req.file.filename}`;

        return res.json({
            url: fileUrl,
            name: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            type: isImage ? 'image' : 'file'
        });
    } catch (err) {
        console.error('Erro no upload de arquivo:', err);
        return res.status(500).json({ error: 'Erro ao fazer upload do arquivo.' });
    }
});

module.exports = router;
