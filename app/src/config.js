const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    JWT_SECRET: process.env.JWT_SECRET || 'micord_super_secret_jwt_key_2026',
    UPLOAD_DIR: path.resolve(__dirname, '..', 'uploads'),
    MAX_FILE_SIZE_MB: 25 // 25MB para imagens e arquivos
};
