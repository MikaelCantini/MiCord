// Controle de Tema: Branco com Rosa Claro (Padrão) / Modo Escuro
const ThemeManager = {
    init() {
        const savedTheme = localStorage.getItem('csgonades_theme') || 'light';
        this.applyTheme(savedTheme);

        const toggleBtn = document.getElementById('btn-toggle-theme');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggle());
        }
    },

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('csgonades_theme', theme);

        const icon = document.getElementById('theme-icon');
        if (icon) {
            icon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
    },

    toggle() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        this.applyTheme(next);
    }
};

window.ThemeManager = ThemeManager;
document.addEventListener('DOMContentLoaded', () => ThemeManager.init());
