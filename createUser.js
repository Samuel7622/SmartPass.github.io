// createUser.js (já adaptado)
require('dotenv').config();
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

async function createTestUser() {
    const name = 'João Teste';
    const email = 'joao@teste.com';
    const password = '123456';
    const hash = await bcrypt.hash(password, 10);
    
    connection.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [name, email, hash, 'user'],
        (err, result) => {
            if (err) console.error('Erro:', err);
            else console.log('Usuário criado, ID:', result.insertId);
            connection.end();
        }
    );
}

createTestUser();