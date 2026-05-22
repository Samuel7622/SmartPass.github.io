// criar-usuario.js (versão multi-tabela)
require('dotenv').config();
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

// Argumentos: nome, email, senha, tipo
const [,, nome, email, senha, tipo] = process.argv;

const tiposValidos = ['aluno', 'admin_ifpi', 'admin_master', 'guarita'];
if (!nome || !email || !senha || !tipo) {
    console.log('Uso: node criar-usuario.js "Nome" "email@exemplo.com" "senha123" [aluno|admin_ifpi|admin_master|guarita]');
    process.exit(1);
}
if (!tiposValidos.includes(tipo)) {
    console.log('Tipo inválido. Use: aluno, admin_ifpi, admin_master ou guarita');
    process.exit(1);
}

const connection = mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'smartpass_db'
});

async function criar() {
    const hash = await bcrypt.hash(senha, 10);
    
    // Mapeia tipo -> nome da tabela
    const tabela = tipo; // os nomes são iguais: aluno, admin_ifpi, admin_master, guarita

    const query = `INSERT INTO ${tabela} (name, email, password_hash) VALUES (?, ?, ?)`;
    connection.query(query, [nome, email, hash], (err, result) => {
        if (err) {
            console.error('❌ Erro:', err);
        } else {
            console.log(`✅ ${tipo} criado: ${email} (ID: ${result.insertId}) na tabela ${tabela}`);
        }
        connection.end();
    });
}

criar();