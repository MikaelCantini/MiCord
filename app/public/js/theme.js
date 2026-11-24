// Controle de Paletas de Cores / Temas do MiCord (Padrão: dark-midnight)
const ThemeManager = {
    validThemes: ['dark-midnight', 'dark', 'dark-emerald', 'light', 'light-ocean'],
    defaultTheme: 'dark-midnight',

    init() {
        const saved = localStorage.getItem('micord_theme');
        const initialTheme = this.validThemes.includes(saved) ? saved : this.defaultTheme;
        this.applyTheme(initialTheme, false);

        const toggleBtn = document.getElementById('btn-toggle-theme');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.openPicker());
        }

        document.querySelectorAll('.theme-option-card').forEach(card => {
            card.addEventListener('click', () => {
                const chosen = card.getAttribute('data-theme-choice');
                if (chosen) {
                    this.applyTheme(chosen, true);
                }
            });
        });
    },

    openPicker() {
        const modal = document.getElementById('modal-theme-picker');
        if (modal) {
            this.highlightActiveCard(document.documentElement.getAttribute('data-theme') || this.defaultTheme);
            modal.style.display = 'flex';
        }
    },

    applyTheme(theme, showFeedback = false) {
        const safeTheme = this.validThemes.includes(theme) ? theme : this.defaultTheme;
        document.documentElement.setAttribute('data-theme', safeTheme);
        localStorage.setItem('micord_theme', safeTheme);
        this.highlightActiveCard(safeTheme);

        if (showFeedback && window.App) {
            const labels = {
                'dark-midnight': 'Midnight Azul (Dark)',
                'dark': 'Rosa Neon (Dark)',
                'dark-emerald': 'Esmeralda (Dark)',
                'light': 'Rosa Sakura (Light)',
                'light-ocean': 'Azul Oceano (Light)'
            };
            window.App.showToast(`🎨 Tema alterado para ${labels[safeTheme] || safeTheme}!`);
        }
    },

    highlightActiveCard(activeTheme) {
        document.querySelectorAll('.theme-option-card').forEach(card => {
            card.classList.toggle('active', card.getAttribute('data-theme-choice') === activeTheme);
        });
    }
};

window.ThemeManager = ThemeManager;
document.addEventListener('DOMContentLoaded', () => ThemeManager.init());
