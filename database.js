// ============================================
// DATABASE.JS - Sistema de Autenticação + Configurações Globais
// ============================================

// Usuários padrão do sistema
const defaultUsers = [
    {
        id: 1,
        name: 'Admin',
        email: 'admin@ifpi.edu.br',
        password: 'admin123',
        role: 'Administrador'
    },
    {
        id: 2,
        name: 'Professor',
        email: 'professor@ifpi.edu.br',
        password: 'prof123',
        role: 'Professor'
    }
];

// Inicializar usuários no localStorage
function initDatabase() {
    if (!localStorage.getItem('users')) {
        localStorage.setItem('users', JSON.stringify(defaultUsers));
        console.log('✅ Banco de dados inicializado com usuários padrão');
    }
}

// Login
function login(email, password) {
    const users = JSON.parse(localStorage.getItem('users')) || defaultUsers;
    const user = users.find(u => u.email === email && u.password === password);
    
    if (user) {
        const userData = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            loginTime: new Date().toISOString()
        };
        
        localStorage.setItem('currentUser', JSON.stringify(userData));
        console.log('✅ Login bem-sucedido:', user.name);
        return { success: true, user: userData };
    }
    
    console.log('❌ Login falhou');
    return { success: false, message: 'Email ou senha incorretos' };
}

// Logout
function logout() {
    localStorage.removeItem('currentUser');
    console.log('👋 Logout realizado');
    window.location.href = 'arduino-menu.html';
}

// Obter usuário atual
function getCurrentUser() {
    const userData = localStorage.getItem('currentUser');
    return userData ? JSON.parse(userData) : null;
}

// Verificar se está logado
function isLoggedIn() {
    return getCurrentUser() !== null;
}

// Carregar dados do usuário no header
function loadUserData() {
    const user = getCurrentUser();
    
    if (!user) {
        console.log('⚠️ Usuário não logado');
        return false;
    }
    
    // Atualizar elementos do header se existirem
    const avatarEl = document.getElementById('headerUserAvatar');
    const nameEl = document.getElementById('headerUserName');
    const roleEl = document.getElementById('headerUserRole');
    const welcomeEl = document.getElementById('welcomeName');
    
    if (avatarEl) avatarEl.textContent = user.name.charAt(0).toUpperCase();
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) roleEl.textContent = user.role;
    if (welcomeEl) welcomeEl.textContent = user.name;
    
    console.log('✅ Dados do usuário carregados:', user.name);
    return true;
}

// ============================================
// SISTEMA DE TEMA E CONFIGURAÇÕES GLOBAIS
// ============================================

// Aplicar tema (modo escuro) em TODAS as páginas
function applyTheme() {
    const darkMode = localStorage.getItem('darkMode') === 'true';
    
    if (darkMode) {
        document.body.setAttribute('data-theme', 'dark');
        console.log('🌙 Modo escuro ativado');
    } else {
        document.body.removeAttribute('data-theme');
        console.log('☀️ Modo claro ativado');
    }
}

// Aplicar tamanho de fonte em TODAS as páginas
function applyFontSize() {
    const fontSize = localStorage.getItem('fontSize') || '16';
    document.body.style.fontSize = fontSize + 'px';
    console.log('📏 Tamanho da fonte:', fontSize + 'px');
}

// Aplicar TODAS as configurações
function applyAllSettings() {
    applyTheme();
    applyFontSize();
    
    // Outras configurações podem ser adicionadas aqui
    const config = JSON.parse(localStorage.getItem('systemConfig') || '{}');
    console.log('⚙️ Configurações aplicadas:', config);
}

// Salvar configuração individual
function saveSetting(key, value) {
    localStorage.setItem(key, value);
    console.log(`💾 Configuração salva: ${key} = ${value}`);
}

// Obter configuração
function getSetting(key, defaultValue = null) {
    return localStorage.getItem(key) || defaultValue;
}

// ============================================
// INICIALIZAÇÃO AUTOMÁTICA
// ============================================

// Inicializar ao carregar QUALQUER página
document.addEventListener('DOMContentLoaded', function() {
    console.log('📦 Database.js carregado');
    
    initDatabase();
    applyAllSettings(); // ✅ APLICA TEMA E CONFIGURAÇÕES EM TODAS AS PÁGINAS
    
    // Se houver user data, carregar
    if (document.getElementById('headerUserAvatar')) {
        loadUserData();
    }
});

// Observar mudanças no localStorage (sincronizar entre abas)
window.addEventListener('storage', function(e) {
    if (e.key === 'darkMode' || e.key === 'fontSize') {
        console.log('🔄 Configuração alterada em outra aba, sincronizando...');
        applyAllSettings();
    }
});

// ============================================
// EXPORTAR FUNÇÕES GLOBALMENTE
// ============================================

window.login = login;
window.logout = logout;
window.getCurrentUser = getCurrentUser;
window.isLoggedIn = isLoggedIn;
window.loadUserData = loadUserData;
window.applyTheme = applyTheme;
window.applyFontSize = applyFontSize;
window.applyAllSettings = applyAllSettings;
window.saveSetting = saveSetting;
window.getSetting = getSetting;