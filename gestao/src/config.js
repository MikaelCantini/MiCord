const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3001,
    JWT_SECRET: process.env.JWT_SECRET || 'micord_gestao_admin_secret_key_2026',
    DB_PATH: path.resolve(__dirname, '..', 'database', 'app.db')
};
