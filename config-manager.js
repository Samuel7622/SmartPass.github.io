// ============================================
// CONFIG-MANAGER.JS - VERSAO GARANTIDA
// Sistema de Configurações Globais SmartPass
// ============================================

// ===== CONFIG MANAGER CLASS =====
class ConfigManager {
    constructor() {
        console.log('🎛️ ConfigManager iniciando...');
        this.config = this.carregarConfiguracoes();
        this.aplicarConfiguracoesImediatas();
        console.log('✅ ConfigManager pronto!', this.config);
    }

    carregarConfiguracoes() {
        try {
            const configSalva = localStorage.getItem('systemConfig');
            if (configSalva) {
                return JSON.parse(configSalva);
            }
        } catch (error) {
            console.log('⚠️ Erro ao carregar configurações:', error);
        }

        // Configurações padrão
        return {
            darkMode: false,
            fontSize: 'normal',
            notifAcesso: true,
            somAlerta: true,
            backup: true
        };
    }

    aplicarConfiguracoesImediatas() {
        console.log('🎨 Aplicando configurações...');
        
        // Modo escuro
        if (this.config.darkMode) {
            document.body.setAttribute('data-theme', 'dark');
            console.log('🌙 Modo escuro: ATIVADO');
        } else {
            document.body.removeAttribute('data-theme');
            console.log('☀️ Modo escuro: DESATIVADO');
        }

        // Tamanho da fonte
        document.body.setAttribute('data-font-size', this.config.fontSize);
        console.log('📏 Tamanho fonte:', this.config.fontSize);
    }

    salvarConfiguracoes() {
        try {
            localStorage.setItem('systemConfig', JSON.stringify(this.config));
            this.aplicarConfiguracoesImediatas();
            this.mostrarNotificacao('Configurações salvas!');
            console.log('💾 Configurações salvas:', this.config);
        } catch (error) {
            console.error('❌ Erro ao salvar:', error);
        }
    }

    toggleDarkMode() {
        console.log('🔄 Alternando modo escuro...');
        this.config.darkMode = !this.config.darkMode;
        this.salvarConfiguracoes();
    }

    changeFontSize(tamanho) {
        console.log('🔄 Alterando tamanho fonte:', tamanho);
        this.config.fontSize = tamanho;
        this.salvarConfiguracoes();
    }

    mostrarNotificacao(mensagem) {
        console.log('🔔 Notificação:', mensagem);
        
        // Criar notificação simples
        const notif = document.createElement('div');
        notif.textContent = mensagem;
        notif.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            background: #1d4903;
            color: white;
            padding: 15px 20px;
            border-radius: 5px;
            z-index: 9999;
            font-family: Arial;
            font-size: 14px;
        `;
        
        document.body.appendChild(notif);
        
        setTimeout(() => {
            notif.remove();
        }, 2000);
    }
}

// ===== INICIALIZAÇÃO GLOBAL =====
let configManager;

function inicializarConfigManager() {
    try {
        configManager = new ConfigManager();
        console.log('🎉 ConfigManager inicializado com sucesso!');
        return true;
    } catch (error) {
        console.error('💥 ERRO CRÍTICO no ConfigManager:', error);
        return false;
    }
}

// ===== FUNÇÕES GLOBAIS =====
function toggleDarkMode() {
    if (configManager) {
        configManager.toggleDarkMode();
    } else {
        alert('❌ Sistema de configurações não carregado!');
        console.error('ConfigManager não disponível');
    }
}

function changeFontSize() {
    const select = document.getElementById('fontSizeSelect');
    if (select && configManager) {
        configManager.changeFontSize(select.value);
    }
}

function salvarConfiguracoes() {
    if (configManager) {
        // Atualizar outras configurações
        configManager.config.notifAcesso = document.getElementById('notifAcessoToggle')?.checked || true;
        configManager.config.somAlerta = document.getElementById('somAlertaToggle')?.checked || true;
        configManager.config.backup = document.getElementById('backupToggle')?.checked || true;
        
        configManager.salvarConfiguracoes();
        alert('✅ Configurações salvas com sucesso!');
    }
}

function limparCache() {
    if (confirm('Limpar cache?')) {
        localStorage.removeItem('systemConfig');
        alert('Cache limpo! A página será recarregada.');
        location.reload();
    }
}

// ===== INICIALIZAR QUANDO PÁGINA CARREGAR =====
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Página carregada - Inicializando ConfigManager...');
    
    const sucesso = inicializarConfigManager();
    
    if (sucesso && document.getElementById('darkModeToggle')) {
        // Preencher controles na página de configurações
        document.getElementById('darkModeToggle').checked = configManager.config.darkMode;
        document.getElementById('fontSizeSelect').value = configManager.config.fontSize;
        document.getElementById('notifAcessoToggle').checked = configManager.config.notifAcesso;
        document.getElementById('somAlertaToggle').checked = configManager.config.somAlerta;
        document.getElementById('backupToggle').checked = configManager.config.backup;
        
        console.log('🎛️ Controles preenchidos com sucesso!');
    }
});

// ===== EXPORTAR PARA USO GLOBAL =====
window.configManager = configManager;
window.toggleDarkMode = toggleDarkMode;
window.changeFontSize = changeFontSize;
window.salvarConfiguracoes = salvarConfiguracoes;
window.limparCache = limparCache;

console.log('🔧 config-manager.js carregado - Aguardando inicialização...');