require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// ========== IMPORTS PARA WHATSAPP (FILA) ==========
const { addToQueue } = require('./src/queues/whatsappQueue');
const worker = require('./src/queues/whatsappWorker');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
let todasLiberacoesBD = [], paginaAtual = 1, tabAtual = 'presencas', itensPorPagina = 20, ws = null;
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ FATAL: JWT_SECRET não definido no .env!');
    process.exit(1);
}

const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'smartpass_db',
    waitForConnections: true,
    connectionLimit: 10
});

// ==================== CRIAÇÃO DAS TABELAS ====================
(async () => {
    try {
        const conn = await db.getConnection();
        console.log('✅ Conectado ao MySQL!');
        
        // ========== CRIAÇÃO DE TODAS AS TABELAS (ordem correta) ==========
        
        // 1. admin_gestao
        await conn.query(`
            CREATE TABLE IF NOT EXISTS admin_gestao (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                ativo TINYINT DEFAULT 1,
                criado_por INT NULL,
                criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela admin_gestao verificada/criada');
        
        // 2. horarios_turma
        await conn.query(`
            CREATE TABLE IF NOT EXISTS horarios_turma (
                id INT PRIMARY KEY AUTO_INCREMENT,
                turma_nome VARCHAR(100) NOT NULL,
                dia_semana TINYINT NOT NULL,
                horario_saida VARCHAR(5) NOT NULL,
                criado_por VARCHAR(100),
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela horarios_turma verificada/criada');
        
        // 3. calendario_escolar
        await conn.query(`
            CREATE TABLE IF NOT EXISTS calendario_escolar (
                id INT PRIMARY KEY AUTO_INCREMENT,
                data DATE UNIQUE NOT NULL,
                tipo ENUM('feriado_nacional', 'feriado_local', 'ponto_facultativo', 'sabado_letivo', 'recesso') NOT NULL,
                descricao VARCHAR(150),
                horario_saida TIME NULL,
                criado_por VARCHAR(100),
                criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela calendario_escolar verificada/criada');
        
        // 4. alunos
        await conn.query(`
            CREATE TABLE IF NOT EXISTS alunos (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                matricula VARCHAR(50) UNIQUE NOT NULL,
                ano VARCHAR(20),
                curso VARCHAR(50),
                tipo_acesso ENUM('RFID','BIO','AMBOS') DEFAULT 'RFID',
                rfid_uid VARCHAR(50),
                bio_id VARCHAR(50),
                responsavel_nome VARCHAR(100),
                responsavel_telefone VARCHAR(20),
                responsavel_email VARCHAR(100),
                data_cadastro DATETIME,
                foto MEDIUMTEXT,
                email VARCHAR(100),
                password_hash VARCHAR(255)
            )
        `);
        console.log('✅ Tabela alunos verificada/criada');
        
        // 5. admin_master
        await conn.query(`
            CREATE TABLE IF NOT EXISTS admin_master (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL
            )
        `);
        console.log('✅ Tabela admin_master verificada/criada');
        
        // 6. guarita
        await conn.query(`
            CREATE TABLE IF NOT EXISTS guarita (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL
            )
        `);
        console.log('✅ Tabela guarita verificada/criada');
        
        // 7. presencas
        await conn.query(`
            CREATE TABLE IF NOT EXISTS presencas (
                id INT PRIMARY KEY AUTO_INCREMENT,
                aluno_id INT NOT NULL,
                tipo_sistema VARCHAR(10),
                data DATE,
                entrada TIME,
                saida TIME,
                status VARCHAR(20),
                tipo_liberacao VARCHAR(50) NULL,
                FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Tabela presencas verificada/criada');
        
        // 8. logs_acessos
        await conn.query(`
            CREATE TABLE IF NOT EXISTS logs_acessos (
                id INT PRIMARY KEY AUTO_INCREMENT,
                aluno_id INT,
                nome_aluno VARCHAR(100),
                matricula VARCHAR(50),
                aprovado BOOLEAN,
                motivo VARCHAR(100),
                tipo_sistema VARCHAR(10),
                hora TIME,
                data DATE,
                created_at DATETIME
            )
        `);
        console.log('✅ Tabela logs_acessos verificada/criada');
        
        // 9. liberacoes
        await conn.query(`
            CREATE TABLE IF NOT EXISTS liberacoes (
                id INT PRIMARY KEY AUTO_INCREMENT,
                tipo ENUM('individual', 'turma', 'escola') NOT NULL,
                matricula VARCHAR(50) NULL,
                turma_nome VARCHAR(100) NULL,
                justificativa TEXT NOT NULL,
                autorizado_por VARCHAR(100) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NOT NULL,
                status TINYINT DEFAULT 1
            )
        `);
        console.log('✅ Tabela liberacoes verificada/criada');
        
        // 10. Adicionar coluna horario_agendado se não existir
        try {
            await conn.query(`
                ALTER TABLE liberacoes 
                ADD COLUMN horario_agendado VARCHAR(5) NULL DEFAULT NULL
            `);
            console.log('✅ Coluna horario_agendado adicionada com sucesso');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('ℹ️ Coluna horario_agendado já existe, ignorando...');
            } else {
                console.error('❌ Erro ao adicionar coluna horario_agendado:', err.message);
            }
        }
        
        // 11. configuracoes_sistema
        await conn.query(`
            CREATE TABLE IF NOT EXISTS configuracoes_sistema (
                chave VARCHAR(50) PRIMARY KEY,
                valor VARCHAR(255) NOT NULL,
                atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela configuracoes_sistema verificada/criada');
        
        // ========== TABELA DE CONFIGURAÇÃO DE SÁBADOS (COM horario_saida NULL) ==========
        await conn.query(`
            CREATE TABLE IF NOT EXISTS sabados_config (
                id INT PRIMARY KEY AUTO_INCREMENT,
                data DATE NOT NULL,
                turma_nome VARCHAR(100) NULL,
                tipo ENUM('aula', 'prova', 'simulado', 'recesso', 'nao_letivo') NOT NULL,
                horario_entrada TIME NULL,
                horario_saida TIME NULL,
                bloqueio_entrada TIME NULL,
                justificativa TEXT NULL,
                criado_por VARCHAR(100),
                criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_sabado_turma (data, turma_nome)
            )
        `);
        console.log('✅ Tabela sabados_config verificada/criada (com horario_saida NULL)');
        
        // Se por acaso a tabela já existia com a coluna NOT NULL (de uma versão anterior), forçamos a alteração
        try {
            await conn.query(`
                ALTER TABLE sabados_config 
                MODIFY COLUMN horario_saida TIME NULL
            `);
            console.log('✅ Coluna horario_saida garantida como TIME NULL');
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME' && !err.message.includes('Duplicate')) {
                console.warn('⚠️ Não foi possível alterar coluna horario_saida:', err.message);
            }
        }
        
        // Inicializar horario_limite_ativo
        const [cfg] = await conn.query(`SELECT valor FROM configuracoes_sistema WHERE chave = 'horario_limite_ativo'`);
        if (cfg.length === 0) {
            await conn.query(`INSERT INTO configuracoes_sistema (chave, valor) VALUES ('horario_limite_ativo', 'true')`);
            horarioLimiteAtivo = true;
        } else {
            horarioLimiteAtivo = cfg[0].valor === 'true';
        }
        console.log(`📌 Configuração horario_limite_ativo = ${horarioLimiteAtivo}`);
        
        // Criar admin master padrão
        const [adminExists] = await conn.query('SELECT id FROM admin_master WHERE email = ?', ['admin@smartpass.com']);
        if (adminExists.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await conn.query('INSERT INTO admin_master (name, email, password_hash) VALUES (?, ?, ?)', ['Admin Master', 'admin@smartpass.com', hash]);
            console.log('✅ Admin master criado: admin@smartpass.com / admin123');
        }
        
        conn.release();
    } catch (err) {
        console.error('❌ Erro MySQL:', err.message);
    }
})();

// ==================== VARIÁVEIS GLOBAIS ====================
let serialPortRFID = null;
let parserRFID = null;
let serialPortBIO = null;
let parserBIO = null;

let aguardandoRespostaRFID = false;
let callbackRespostaRFID = null;
let aguardandoRespostaBIO = false;
let callbackRespostaBIO = null;

const TIMEOUT_CADASTRO = 120000;
const TIMEOUT_PADRAO = 15000;

let statusEscola = {
    estado: 'ABERTA',
    ultimaMudanca: new Date().toLocaleString('pt-BR'),
    alunosPresentes: new Set(),
    horarioEntrada: '07:00',
    horarioSaida: '17:00',
    horarioFechamento: '18:00',
    horarioLimiteEntrada: '07:15'
};

let horarioLimiteAtivo = true;   // toggle controlado pelo admin master (via /api/config/horario-limite)

let modoEspecial = {
    ativo: false,
    tipo: null,
    motivo: null,
    autorizadoPor: null,
    timeout: null
};

function resetarModoEspecial() {
    if (modoEspecial.timeout) {
        clearTimeout(modoEspecial.timeout);
        modoEspecial.timeout = null;
    }
    modoEspecial.ativo = false;
    modoEspecial.tipo = null;
    modoEspecial.motivo = null;
    modoEspecial.autorizadoPor = null;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'MODO_ESPECIAL_STATUS', ativo: false, tipoModo: null }));
        }
    });
}

function validarTelefoneWhatsApp(telefone) {
    if (!telefone) return true;
    let numeros = telefone.replace(/\D/g, '');
    if (numeros.startsWith('55')) numeros = numeros.substring(2);
    return numeros.length === 10 || numeros.length === 11;
}

let historicoAcessos = [];
const MAX_HISTORICO = 500;
let timeoutAtualizacao = null;

// ==================== FUNÇÕES DE ACESSO A DADOS ====================
async function getAlunoByNome(nome) {
    const [rows] = await db.query('SELECT * FROM alunos WHERE name = ?', [nome]);
    return rows[0];
}
async function getAlunoByUID(uidHex) {
    const [rows] = await db.query('SELECT * FROM alunos WHERE rfid_uid = ?', [uidHex]);
    return rows[0];
}
async function getAlunoByBioId(bioId) {
    const [rows] = await db.query('SELECT * FROM alunos WHERE bio_id = ?', [bioId]);
    return rows[0];
}
async function getAlunoById(id) {
    const [rows] = await db.query('SELECT id, name, matricula, ano, curso, tipo_acesso, rfid_uid, bio_id FROM alunos WHERE id = ?', [id]);
    return rows[0];
}
async function getAllAlunos() {
    const [rows] = await db.query(`
        SELECT a.id, a.name, a.matricula, a.ano, a.curso, a.tipo_acesso,
               a.responsavel_nome, a.responsavel_telefone, a.responsavel_email,
               a.data_cadastro, a.foto,
               p.entrada, p.saida, p.status as status_presenca
        FROM alunos a
        LEFT JOIN (
            SELECT * FROM (
                SELECT aluno_id, entrada, saida, status,
                       ROW_NUMBER() OVER (PARTITION BY aluno_id ORDER BY id DESC) as rn
                FROM presencas
                WHERE data = CURDATE()
            ) ranked WHERE rn = 1
        ) p ON p.aluno_id = a.id
        ORDER BY a.name
    `);
    return rows;
}
async function registrarAcessoLog(alunoId, nome, matricula, aprovado, motivo, tipo) {
    await db.query(
        `INSERT INTO logs_acessos (aluno_id, nome_aluno, matricula, aprovado, motivo, tipo_sistema, hora, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIME, CURDATE(), NOW())`,
        [alunoId, nome, matricula, aprovado ? 1 : 0, motivo, tipo]
    );
}
async function isAlunoLiberado(aluno) {
    await db.query('DELETE FROM liberacoes WHERE expires_at < NOW() OR status = 0');

    const [ind] = await db.query(
        'SELECT id FROM liberacoes WHERE tipo = "individual" AND matricula = ? AND status = 1 AND expires_at > NOW()',
        [aluno.matricula]
    );
    if (ind.length) return true;

    const turmaAluno = `${aluno.ano} ${aluno.curso}`;
    const [tur] = await db.query(
        `SELECT id FROM liberacoes 
         WHERE tipo = "turma" 
           AND status = 1 
           AND expires_at > NOW()
           AND turma_nome = ?`,
        [turmaAluno]
    );
    if (tur.length) return true;

    const [esc] = await db.query(
        'SELECT id FROM liberacoes WHERE tipo = "escola" AND status = 1 AND expires_at > NOW()'
    );
    return esc.length > 0;
}
async function getLiberacaoAtiva(aluno) {
    await db.query('UPDATE liberacoes SET status = 0 WHERE expires_at < NOW()');

    const [ind] = await db.query(
        'SELECT *, horario_agendado FROM liberacoes WHERE tipo = "individual" AND matricula = ? AND status = 1 AND expires_at > NOW() LIMIT 1',
        [aluno.matricula]
    );
    if (ind.length) return ind[0];

    const turmaAluno = `${aluno.ano} ${aluno.curso}`;
    const [tur] = await db.query(
        'SELECT *, horario_agendado FROM liberacoes WHERE tipo = "turma" AND status = 1 AND expires_at > NOW() AND turma_nome = ? LIMIT 1',
        [turmaAluno]
    );
    if (tur.length) return tur[0];

    const [esc] = await db.query(
        'SELECT *, horario_agendado FROM liberacoes WHERE tipo = "escola" AND status = 1 AND expires_at > NOW() LIMIT 1'
    );
    return esc.length ? esc[0] : null;
}
// ==================== WEBSOCKET E BROADCASTS ====================
async function broadcastStatus() {
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM alunos');
    const [[{ totalBio }]] = await db.query("SELECT COUNT(*) as totalBio FROM alunos WHERE tipo_acesso IN ('BIO','AMBOS') AND bio_id IS NOT NULL");
    const status = {
        rfidConectado: serialPortRFID && serialPortRFID.isOpen,
        biometricoConectado: serialPortBIO && serialPortBIO.isOpen,
        horarioLimiteAtivo: horarioLimiteAtivo,
        totalAlunos: total,
        totalDigitais: totalBio,
        ultimaAtualizacao: new Date().toLocaleString('pt-BR'),
        escola: {
            estado: statusEscola.estado,
            ultimaMudanca: statusEscola.ultimaMudanca,
            alunosPresentes: statusEscola.alunosPresentes.size,
            horarioEntrada: statusEscola.horarioEntrada,
            horarioSaida: statusEscola.horarioSaida,
            horarioFechamento: statusEscola.horarioFechamento,
            horarioLimiteEntrada: statusEscola.horarioLimiteEntrada
        }
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'STATUS_GERAL', status }));
        }
    });
}
function broadcastUltimoAcesso(acesso) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'ULTIMO_ACESSO', acesso }));
        }
    });
}
function broadcastAtualizacaoAlunos() {
    if (timeoutAtualizacao) clearTimeout(timeoutAtualizacao);
    timeoutAtualizacao = setTimeout(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ tipo: 'ATUALIZAR_ALUNOS', timestamp: new Date().toLocaleString('pt-BR') }));
            }
        });
        timeoutAtualizacao = null;
    }, 100);
}
function broadcastStatusCadastro(mensagem, tipo, sistema) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'STATUS_CADASTRO', mensagem, sistema, timestamp: new Date().toLocaleString('pt-BR') }));
        }
    });
}

// ==================== REGISTRO DE ACESSO E RESPOSTA AOS ARDUINOS ====================
async function registrarAcesso(nome, matricula, aprovado, motivo = '', tipo = 'RFID') {
    try {
        let alunoId = null;
        let turma = 'N/A';
        if (matricula !== 'N/A') {
            const [rows] = await db.query('SELECT id, curso, ano FROM alunos WHERE matricula = ?', [matricula]);
            if (rows.length) {
                alunoId = rows[0].id;
                turma = `${rows[0].curso || 'N/A'} - ${rows[0].ano || 'N/A'}`;
            }
        }
        const acesso = {
            id: Date.now(),
            nome: nome || 'Não identificado',
            matricula: matricula || 'N/A',
            aprovado,
            motivo,
            tipo,
            turma,
            timestamp: new Date().toLocaleString('pt-BR'),
            hora: new Date().toLocaleTimeString('pt-BR'),
            data: new Date().toLocaleDateString('pt-BR')
        };
        await registrarAcessoLog(alunoId, acesso.nome, acesso.matricula, aprovado, motivo, tipo);
        historicoAcessos.unshift(acesso);
        if (historicoAcessos.length > MAX_HISTORICO) historicoAcessos.pop();
        broadcastUltimoAcesso(acesso);
        broadcastAtualizacaoAlunos();
        await broadcastStatus();
        return acesso;
    } catch (error) {
        console.error('[ERRO] registrarAcesso:', error.message);
    }
}

function enviarRespostaAcesso(tipo, resposta) {
    if (tipo === 'RFID' && serialPortRFID?.isOpen) {
        serialPortRFID.write(`RESPOSTA_ACESSO:${resposta}\n`);
        console.log(`[RFID] Enviado: RESPOSTA_ACESSO:${resposta}`);
    }
    if (tipo === 'BIO' && serialPortBIO?.isOpen) {
        serialPortBIO.write(`RESPOSTA_ACESSO:${resposta}\n`);
        console.log(`[BIO] Enviado: RESPOSTA_ACESSO:${resposta}`);
    }
}

// ==================== FUNÇÃO PRINCIPAL DE MARCAÇÃO DE PRESENÇA (COM CORREÇÃO) ====================
async function marcarPresenca(nome, tipo) {
    try {
        const aluno = await getAlunoByNome(nome);
        if (!aluno) {
            await registrarAcesso(nome, 'N/A', false, 'ALUNO_NAO_ENCONTRADO', tipo);
            enviarRespostaAcesso(tipo, 'NAO:ALUNO_NAO_ENCONTRADO');
            return;
        }

        // ========== VERIFICAÇÃO DE SÁBADO ==========
        const diaSemana = new Date().getDay();
        if (diaSemana === 6) {
            // ... lógica de sábado (usa CURDATE() no banco, mas não precisa de hojeDate)
            // ... Use CURDATE() nas consultas ao banco
        }

        // ========== VERIFICAÇÃO DE LIBERAÇÃO ==========
        const liberacaoAtiva = await getLiberacaoAtiva(aluno);
        if (liberacaoAtiva) {
            const alunoId = Number(aluno.id);
            // Remove 'hoje' e 'horaAtual'
            // ... use CURDATE() e CURRENT_TIME nas queries
            const [presenca] = await db.query(
                'SELECT id, saida FROM presencas WHERE aluno_id = ? AND data = CURDATE() ORDER BY id DESC LIMIT 1',
                [alunoId]
            );

            if (presenca.length === 0 || presenca[0].saida) {
                await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'LIBERADO', 'LIBERADO_GESTAO')
`, [alunoId, tipo]);
                statusEscola.alunosPresentes.add(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'LIBERACAO_GESTAO_ENTRADA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:LIBERADO_PELA_GESTAO');
                console.log(`[LIBERAÇÃO] ✅ ENTRADA registrada para ${nome}`);
            } else {
                await db.query(`
                    UPDATE presencas SET saida = CURRENT_TIME, status = 'SAIU', tipo_liberacao = 'LIBERADO_GESTAO'
                    WHERE id = ?
                `, [presenca[0].id]);
                statusEscola.alunosPresentes.delete(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_LIBERADA_PELA_GESTAO', tipo);
                enviarRespostaAcesso(tipo, 'SIM:SAIDA_LIBERADA');
                console.log(`[LIBERAÇÃO] ✅ SAÍDA registrada para ${nome}`);

                if (liberacaoAtiva.tipo === 'individual') {
                    await db.query('UPDATE liberacoes SET status = 0 WHERE id = ?', [liberacaoAtiva.id]);
                    console.log(`[LIBERAÇÃO] 🔒 Liberação individual ID ${liberacaoAtiva.id} consumida para ${nome}`);
                }

                if (aluno.responsavel_telefone) {
                    await addToQueue({
                        tipo: 'saidaLiberada',
                        destinatario: aluno.responsavel_telefone,
                        dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR'), motivo: liberacaoAtiva.justificativa, autorizadoPor: liberacaoAtiva.autorizado_por }
                    });
                }
            }
            broadcastAtualizacaoAlunos();
            await broadcastStatus();
            return;
        }

        // ========== MODO ESPECIAL ==========
        if (modoEspecial.ativo) {
            console.log(`[MODO ESPECIAL] ATIVO! Tipo: ${modoEspecial.tipo}, Aluno: ${nome}`);
            const tipoModo = modoEspecial.tipo;
            const motivoModo = modoEspecial.motivo;
            const autorizadoPorModo = modoEspecial.autorizadoPor;

            const alunoId = Number(aluno.id);
            const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour12: false }); // só para log e resposta
            const observacao = `${motivoModo} | Autorizado por: ${autorizadoPorModo}`;
            let respostaAcesso = '';

            if (tipoModo === 'SAIDA_JUSTIFICADA') {
                const [presenca] = await db.query(
                    'SELECT * FROM presencas WHERE aluno_id = ? AND data = CURDATE() ORDER BY id DESC LIMIT 1',
                    [alunoId]
                );
                if (presenca.length > 0 && !presenca[0].saida) {
                    await db.query(`
                        UPDATE presencas 
                        SET saida = CURRENT_TIME, status = 'SAIDA_JUSTIFICADA', tipo_liberacao = 'MODO_ESPECIAL'
                        WHERE id = ?
                    `, [presenca[0].id]);
                } else {
                    await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'SAIDA_JUSTIFICADA', 'MODO_ESPECIAL')
`, [alunoId, tipo]);
                }
                statusEscola.alunosPresentes.delete(alunoId);
                await db.query(
                    `INSERT INTO logs_acessos (aluno_id, nome_aluno, matricula, aprovado, motivo, tipo_sistema, hora, data, created_at)
                     VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIME, CURDATE(), NOW())`,
                    [alunoId, aluno.name, aluno.matricula, `SAIDA_JUSTIFICADA|${observacao}`, tipo]
                );
                if (aluno.responsavel_telefone) {
                    await addToQueue({
                        tipo: 'saidaJustificada',
                        destinatario: aluno.responsavel_telefone,
                        dados: { nomeAluno: aluno.name, horario: horaAtual, motivo: motivoModo, autorizadoPor: autorizadoPorModo }
                    });
                }
                respostaAcesso = 'SIM:SAIDA_PERMITIDA';
            } else if (tipoModo === 'ENTRADA_ATRASADA') {
                await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'ENTRADA_ATRASADA', 'MODO_ESPECIAL')
`, [alunoId, tipo]);
                statusEscola.alunosPresentes.add(alunoId);
                await db.query(
                    `INSERT INTO logs_acessos (aluno_id, nome_aluno, matricula, aprovado, motivo, tipo_sistema, hora, data, created_at)
                     VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIME, CURDATE(), NOW())`,
                    [alunoId, aluno.name, aluno.matricula, `ENTRADA_ATRASADA|${observacao}`, tipo]
                );
                respostaAcesso = 'SIM:ENTRADA_PERMITIDA';
                if (aluno.responsavel_telefone) {
                    await addToQueue({
                        tipo: 'atraso',
                        destinatario: aluno.responsavel_telefone,
                        dados: { nomeAluno: aluno.name, horario: horaAtual, motivo: motivoModo, autorizadoPor: autorizadoPorModo }
                    });
                }
            }

            // ... registrar acesso e broadcast
            resetarModoEspecial();
            return;
        }

        // ========== LÓGICA DE ACESSO NORMAL ==========
        const alunoId = Number(aluno.id);
        const [presenca] = await db.query(
            'SELECT * FROM presencas WHERE aluno_id = ? AND data = CURDATE() ORDER BY id DESC LIMIT 1',
            [alunoId]
        );
        const estaPresente = presenca.length > 0 && !presenca[0].saida;

        if (horarioLimiteAtivo) {
            // ----- ENTRADA -----
            if (presenca.length === 0) {
                const agora = new Date();
                const [horaLimiteH, horaLimiteM] = statusEscola.horarioLimiteEntrada.split(':').map(Number);
                const passouLimiteEntrada = agora.getHours() > horaLimiteH || 
                                           (agora.getHours() === horaLimiteH && agora.getMinutes() > horaLimiteM);

                if (passouLimiteEntrada) {
                    await registrarAcesso(aluno.name, aluno.matricula, false, 'ENTRADA_FORA_HORARIO', tipo);
                    enviarRespostaAcesso(tipo, 'NAO:ENTRADA_FORA_HORARIO');
                    console.log(`[ACESSO] ❌ ${nome} tentou entrar fora do horário permitido (${statusEscola.horarioLimiteEntrada})`);
                    return;
                }

                await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'PRESENTE', NULL)
`, [alunoId, tipo]);
                statusEscola.alunosPresentes.add(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'ENTRADA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:ENTRADA_PERMITIDA');
                if (aluno.responsavel_telefone) {
                    await addToQueue({ tipo: 'entrada', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                }
                console.log(`[ACESSO] ✅ ${nome} ENTROU às ${new Date().toLocaleTimeString('pt-BR')}`);
                broadcastAtualizacaoAlunos();
                await broadcastStatus();
                return;
            }
            else if (presenca[0].saida) {
                // Reentrada
                await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'PRESENTE', NULL)
`, [alunoId, tipo]);
                statusEscola.alunosPresentes.add(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'REENTRADA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:REENTRADA_PERMITIDA');
                if (aluno.responsavel_telefone) {
                    await addToQueue({ tipo: 'reentrada', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                }
                console.log(`[ACESSO] ✅ ${nome} REENTROU às ${new Date().toLocaleTimeString('pt-BR')}`);
                broadcastAtualizacaoAlunos();
                await broadcastStatus();
                return;
            }
            else {
                // Tentativa de SAÍDA com verificação de horário por turma
                let turmaCompleta = `${aluno.ano} ${aluno.curso}`;
                if (!turmaCompleta.includes('Ano') && turmaCompleta.match(/^\d+°/)) {
                    const partes = turmaCompleta.split(' ');
                    const anoNum = partes[0];
                    const restante = partes.slice(1).join(' ');
                    turmaCompleta = `${anoNum} Ano ${restante}`;
                }
                const diaSemana = new Date().getDay();
                const [horarioRow] = await db.query(
                    `SELECT horario_saida FROM horarios_turma WHERE turma_nome = ? AND dia_semana = ?`,
                    [turmaCompleta, diaSemana]
                );

                let saidaPermitida = false;
                let horarioReferencia = null;

                if (statusEscola.horarioSaidaEspecial) {
                    horarioReferencia = statusEscola.horarioSaidaEspecial;
                } else if (horarioRow.length > 0) {
                    horarioReferencia = horarioRow[0].horario_saida;
                }

                if (!horarioReferencia) {
                    saidaPermitida = true;
                } else {
                    const [horaRef, minRef] = horarioReferencia.split(':').map(Number);
                    const agora = new Date();
                    const horaAtualNum = agora.getHours();
                    const minAtualNum = agora.getMinutes();
                    if (horaAtualNum > horaRef || (horaAtualNum === horaRef && minAtualNum >= minRef)) {
                        saidaPermitida = true;
                    } else {
                        saidaPermitida = false;
                        await registrarAcesso(aluno.name, aluno.matricula, false, `SAIDA_ANTECIPADA (permitido só às ${horarioReferencia})`, tipo);
                        enviarRespostaAcesso(tipo, `NAO:SAIDA_PERMITIDA_SOMENTE_APOS_${horarioReferencia}`);
                        console.log(`[SAIDA] ❌ ${nome} tentou sair antes das ${horarioReferencia}`);
                        return;
                    }
                }

                if (saidaPermitida) {
                    if (presenca.length > 0 && !presenca[0].saida) {
                        await db.query(`
                            UPDATE presencas SET saida = CURRENT_TIME, status = 'SAIU', tipo_liberacao = NULL
                            WHERE id = ?
                        `, [presenca[0].id]);
                    } else {
                        await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'SAIU', NULL)
`, [alunoId, tipo]);
                    }
                    statusEscola.alunosPresentes.delete(alunoId);
                    await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_PERMITIDA', tipo);
                    enviarRespostaAcesso(tipo, 'SIM:SAIDA_PERMITIDA');
                    if (aluno.responsavel_telefone) {
                        await addToQueue({ tipo: 'saida', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                    }
                    console.log(`[SAIDA] ✅ ${nome} SAIU às ${new Date().toLocaleTimeString('pt-BR')}`);
                    broadcastAtualizacaoAlunos();
                    await broadcastStatus();
                    return;
                }
            }
        }
        else {
            // ========== MODO MANUAL ==========
            if (statusEscola.estado === 'ABERTA') {
                if (presenca.length === 0) {
                    await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'PRESENTE', NULL)
`, [alunoId, tipo]);
                    statusEscola.alunosPresentes.add(alunoId);
                    await registrarAcesso(aluno.name, aluno.matricula, true, 'ENTRADA_PERMITIDA', tipo);
                    enviarRespostaAcesso(tipo, 'SIM:ENTRADA_PERMITIDA');
                    if (aluno.responsavel_telefone) {
                        await addToQueue({ tipo: 'entrada', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                    }
                    console.log(`[ACESSO] ✅ ${nome} ENTROU às ${new Date().toLocaleTimeString('pt-BR')}`);
                } else if (presenca[0].saida) {
                    await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'PRESENTE', NULL)
`, [alunoId, tipo]);
                    statusEscola.alunosPresentes.add(alunoId);
                    await registrarAcesso(aluno.name, aluno.matricula, true, 'REENTRADA_PERMITIDA', tipo);
                    enviarRespostaAcesso(tipo, 'SIM:REENTRADA_PERMITIDA');
                    if (aluno.responsavel_telefone) {
                        await addToQueue({ tipo: 'reentrada', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                    }
                    console.log(`[ACESSO] ✅ ${nome} REENTROU às ${new Date().toLocaleTimeString('pt-BR')}`);
                } else {
                    await registrarAcesso(aluno.name, aluno.matricula, true, 'JA_PRESENTE', tipo);
                    enviarRespostaAcesso(tipo, 'SIM:JA_PRESENTE');
                    console.log(`[ACESSO] ℹ️ ${nome} já está presente (ignorado)`);
                }
            }
            else if (statusEscola.estado === 'SAIDA') {
                if (!estaPresente) {
                    await registrarAcesso(aluno.name, aluno.matricula, false, 'NAO_PRESENTE', tipo);
                    enviarRespostaAcesso(tipo, 'NAO:NAO_PRESENTE');
                    console.log(`[ACESSO] ❌ ${nome} tentou sair mas não estava presente`);
                    return;
                }
                if (presenca.length > 0 && !presenca[0].saida) {
                    await db.query(`
                        UPDATE presencas SET saida = CURRENT_TIME, status = 'SAIU', tipo_liberacao = NULL
                        WHERE id = ?
                    `, [presenca[0].id]);
                } else if (presenca.length === 0) {
                    await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'SAIU', NULL)
`, [alunoId, tipo]);
                }
                statusEscola.alunosPresentes.delete(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:SAIDA_PERMITIDA');
                if (aluno.responsavel_telefone) {
                    await addToQueue({ tipo: 'saida', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                }
                console.log(`[SAIDA] ✅ ${nome} SAIU às ${new Date().toLocaleTimeString('pt-BR')}`);
            }
            else if (statusEscola.estado === 'FECHADA') {
                const estaPresenteSet = statusEscola.alunosPresentes.has(alunoId) || (presenca.length > 0 && !presenca[0].saida);
                if (estaPresenteSet) {
                    if (presenca.length > 0 && !presenca[0].saida) {
                        await db.query(`
                            UPDATE presencas 
                            SET saida = CURRENT_TIME, status = 'SAIU', tipo_liberacao = NULL
                            WHERE id = ?
                        `, [presenca[0].id]);
                    } else if (presenca.length === 0) {
                        await db.query(`
    INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status, tipo_liberacao)
    VALUES (?, ?, CURDATE(), CURRENT_TIME, 'SAIU', NULL)
`, [alunoId, tipo]);
                    }
                    statusEscola.alunosPresentes.delete(alunoId);
                    await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_EMERGENCIA', tipo);
                    enviarRespostaAcesso(tipo, 'SIM:SAIDA_EMERGENCIA');
                    if (aluno.responsavel_telefone) {
                        await addToQueue({ tipo: 'saida', destinatario: aluno.responsavel_telefone, dados: { nomeAluno: aluno.name, horario: new Date().toLocaleTimeString('pt-BR') } });
                    }
                    console.log(`[ACESSO] 🚨 ${nome} SAIU EM EMERGÊNCIA às ${new Date().toLocaleTimeString('pt-BR')}`);
                } else {
                    await registrarAcesso(aluno.name, aluno.matricula, false, 'ESCOLA_FECHADA', tipo);
                    enviarRespostaAcesso(tipo, 'NAO:ESCOLA_FECHADA');
                    console.log(`[ACESSO] ❌ ${nome} tentou entrar mas escola está fechada`);
                }
            }
        }
        broadcastAtualizacaoAlunos();
        await broadcastStatus();
    } catch (err) {
        console.error('[ERRO] marcarPresenca:', err);
        enviarRespostaAcesso(tipo, 'NAO:ERRO_INTERNO');
    }
}

// ==================== CONEXÕES COM OS SENSORES ====================
const uidDebounceMap = new Map();

function conectarRFID() {
    let ultimoUIDLido = null;
    try {
        const RFID_PORT = process.env.RFID_PORT || 'COM7';
        serialPortRFID = new SerialPort({ path: RFID_PORT, baudRate: 9600 });
        parserRFID = serialPortRFID.pipe(new ReadlineParser({ delimiter: '\n' }));
        serialPortRFID.on('open', () => { console.log(`[RFID] ✅ Conectado na ${RFID_PORT}`); broadcastStatus(); });
        serialPortRFID.on('error', (err) => { console.log('[RFID] ❌ Erro:', err.message); broadcastStatus(); });
        parserRFID.on('data', async (data) => {
            const msg = data.toString().trim();
            console.log('[RFID RX]', msg);
            if (msg.includes('UID lido:')) {
                const uidMatch = msg.match(/UID lido:\s*([A-F0-9\s]+)/i);
                if (uidMatch) {
                    ultimoUIDLido = uidMatch[1].trim().replace(/\s+/g, '');
                    console.log(`[RFID] UID temporário armazenado: ${ultimoUIDLido}`);
                }
            }
            if (msg.includes('ACESSO_NEGADO:TAG_NAO_CADASTRADA'))
                await registrarAcesso('Desconhecido', 'N/A', false, 'TAG_NAO_CADASTRADA', 'RFID');
            if (msg.includes('Modo cadastro ativado')) {
                ultimoUIDLido = null;
                broadcastStatusCadastro('Aproxime a tag RFID do leitor...', 'info', 'RFID');
            }
            if (msg.startsWith('UID:')) {
                const uidHex = msg.substring(4).trim().replace(/\s+/g, '');
                const agora = Date.now();
                if (uidDebounceMap.has(uidHex) && agora - uidDebounceMap.get(uidHex) < 3000) {
                    console.log(`[RFID] Debounce: ignorando leitura duplicada de ${uidHex}`);
                    return;
                }
                uidDebounceMap.set(uidHex, agora);
                console.log(`[RFID] UID recebido: ${uidHex}`);
                const [aluno] = await db.query('SELECT * FROM alunos WHERE rfid_uid = ?', [uidHex]);
                if (!aluno || aluno.length === 0) {
                    console.log(`[RFID] UID não cadastrado: ${uidHex}`);
                    serialPortRFID.write('RESPOSTA_ACESSO:NAO:UID_NAO_CADASTRADO\n');
                    await registrarAcesso('Desconhecido', 'N/A', false, 'UID_NAO_CADASTRADO', 'RFID');
                } else {
                    await marcarPresenca(aluno[0].name, 'RFID');
                }
            }
            if (aguardandoRespostaRFID && callbackRespostaRFID) {
                if (msg.includes('cadastrado com sucesso') || msg.includes('SUCESSO: Cadastrado')) {
                    const uid = ultimoUIDLido;
                    broadcastStatusCadastro('Tag cadastrada com sucesso!', 'success', 'RFID');
                    callbackRespostaRFID(true, { mensagem: 'Aluno cadastrado com sucesso!', uid });
                    aguardandoRespostaRFID = false;
                    callbackRespostaRFID = null;
                    ultimoUIDLido = null;
                } else if (msg.includes('já está cadastrada')) {
                    broadcastStatusCadastro('Tag já está cadastrada!', 'error', 'RFID');
                    callbackRespostaRFID(false, { mensagem: 'Tag já cadastrada!', uid: null });
                    aguardandoRespostaRFID = false;
                    callbackRespostaRFID = null;
                    ultimoUIDLido = null;
                } else if (msg.includes('removido') || msg.includes('Usuário removido:') || msg.includes('SUCESSO: Usuário removido')) {
                    broadcastStatusCadastro('Usuário removido com sucesso!', 'success', 'RFID');
                    callbackRespostaRFID(true, { mensagem: 'Usuário removido!', uid: null });
                    aguardandoRespostaRFID = false;
                    callbackRespostaRFID = null;
                } else if (msg.includes('Todos os usuários foram removidos') || msg.includes('SUCESSO: Todos os usuários foram removidos')) {
                    broadcastStatusCadastro('Todos os usuários RFID removidos!', 'success', 'RFID');
                    callbackRespostaRFID(true, { mensagem: 'Todos removidos!', uid: null });
                    aguardandoRespostaRFID = false;
                    callbackRespostaRFID = null;
                }
            }
        });
        return true;
    } catch (error) {
        console.log('[RFID] ❌ Falha:', error.message);
        return false;
    }
}

function conectarBiometrico() {
    let ultimoBioId = null;
    try {
        const BIO_PORT = process.env.BIO_PORT || 'COM4';
        serialPortBIO = new SerialPort({ path: BIO_PORT, baudRate: 115200 });
        parserBIO = serialPortBIO.pipe(new ReadlineParser({ delimiter: '\n' }));
        serialPortBIO.on('open', () => { console.log(`[BIO] ✅ Conectado na ${BIO_PORT}`); broadcastStatus(); });
        serialPortBIO.on('error', (err) => { console.log('[BIO] ❌ Erro:', err.message); broadcastStatus(); });
        parserBIO.on('data', async (data) => {
            const msg = data.toString().trim();
            console.log('[BIO RX]', msg);
            let idMatch = msg.match(/ID atribuído:\s*(\d+)/i);
            if (!idMatch) idMatch = msg.match(/ID:\s*(\d+)/i);
            if (idMatch) {
                ultimoBioId = idMatch[1];
                console.log(`[BIO] Bio ID temporário armazenado: ${ultimoBioId}`);
            }
            if (msg.includes('>>> Coloque o dedo no sensor...'))
                broadcastStatusCadastro('Coloque o dedo no sensor...', 'info', 'BIO');
            if (msg.includes('>>> RETIRE o dedo...'))
                broadcastStatusCadastro('RETIRE o dedo do sensor...', 'warning', 'BIO');
            if (msg.includes('>>> Coloque o MESMO dedo novamente...'))
                broadcastStatusCadastro('Coloque o MESMO dedo novamente...', 'info', 'BIO');
            if (msg.includes('Criando modelo biométrico...')) 
                broadcastStatusCadastro('Criando modelo...', 'info', 'BIO');
            if (msg.includes('Armazenando no sensor...')) 
                broadcastStatusCadastro('Armazenando digital...', 'info', 'BIO');
            if (msg.includes('✓ Dedo detectado!')) 
                broadcastStatusCadastro('✓ Dedo detectado!', 'success', 'BIO');
            if (msg.includes('✓ Digital armazenada no sensor')) 
                broadcastStatusCadastro('✓ Digital armazenada!', 'success', 'BIO');
            if (msg.includes('=== CADASTRO CONCLUÍDO ==='))
                broadcastStatusCadastro('Cadastro concluído!', 'success', 'BIO');

            let bioIdMatch = msg.match(/bio:ID:(\d+)/i);
            if (bioIdMatch) {
                const bioId = bioIdMatch[1];
                console.log(`[BIO] ID recebido: ${bioId}`);
                const aluno = await getAlunoByBioId(bioId);
                if (!aluno) {
                    console.log(`[BIO] bio_id não cadastrado: ${bioId}`);
                    serialPortBIO.write('RESPOSTA_ACESSO:NAO:BIO_NAO_CADASTRADO\n');
                    await registrarAcesso('Desconhecido', 'N/A', false, 'BIO_NAO_CADASTRADO', 'BIO');
                } else {
                    await marcarPresenca(aluno.name, 'BIO');
                }
            }
            
            if (aguardandoRespostaBIO && callbackRespostaBIO) {
                if (msg.includes('cadastrado com sucesso')) {
                    const bioId = ultimoBioId;
                    broadcastStatusCadastro('✅ Digital cadastrada!', 'success', 'BIO');
                    callbackRespostaBIO(true, { mensagem: 'Digital cadastrada com sucesso!', bio_id: bioId });
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                    ultimoBioId = null;
                } else if (msg.includes('ERRO:')) {
                    callbackRespostaBIO(false, { mensagem: msg });
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                    ultimoBioId = null;
                } else if (msg.includes('Usuário removido:')) {
                    broadcastStatusCadastro('✅ Digital removida!', 'success', 'BIO');
                    callbackRespostaBIO(true, { mensagem: 'Digital removida!', bio_id: null });
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                } else if (msg.includes('Todos os usuários foram removidos')) {
                    broadcastStatusCadastro('✅ Todas as digitais removidas!', 'success', 'BIO');
                    callbackRespostaBIO(true, { mensagem: 'Todas as digitais removidas!', bio_id: null });
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                }
            }
        });
        return true;
    } catch (error) {
        console.log('[BIO] ❌ Falha:', error.message);
        return false;
    }
}

// ==================== ENVIO DE COMANDOS AOS SENSORES ====================
function enviarComandoRFID(comando, timeoutCustom = null) {
    return new Promise((resolve) => {
        if (!serialPortRFID || !serialPortRFID.isOpen) {
            resolve({ sucesso: false, mensagem: 'RFID não conectado', uid: null });
            return;
        }
        let timeout = timeoutCustom || TIMEOUT_PADRAO;
        if (comando.startsWith('CADASTRAR:')) timeout = TIMEOUT_CADASTRO;
        serialPortRFID.write(comando + '\n');
        aguardandoRespostaRFID = true;
        callbackRespostaRFID = (sucesso, dados) => {
            if (typeof dados === 'string') {
                resolve({ sucesso, mensagem: dados, uid: null });
            } else {
                resolve({ sucesso, mensagem: dados.mensagem, uid: dados.uid });
            }
        };
        setTimeout(() => {
            if (aguardandoRespostaRFID) {
                aguardandoRespostaRFID = false;
                callbackRespostaRFID = null;
                resolve({ sucesso: false, mensagem: 'Timeout - RFID não respondeu', uid: null });
            }
        }, timeout);
    });
}

function enviarComandoBIO(comando, timeoutCustom = null) {
    return new Promise((resolve) => {
        if (!serialPortBIO || !serialPortBIO.isOpen) {
            resolve({ sucesso: false, mensagem: 'Biométrico não conectado', bio_id: null });
            return;
        }
        let timeout = timeoutCustom || TIMEOUT_PADRAO;
        if (comando.startsWith('bio:Cadastrar:')) timeout = TIMEOUT_CADASTRO;
        serialPortBIO.write(comando + '\n');
        aguardandoRespostaBIO = true;
        callbackRespostaBIO = (sucesso, dados) => {
            if (typeof dados === 'string') {
                resolve({ sucesso, mensagem: dados, bio_id: null });
            } else {
                resolve({ sucesso, mensagem: dados.mensagem, bio_id: dados.bio_id });
            }
        };
        setTimeout(() => {
            if (aguardandoRespostaBIO) {
                aguardandoRespostaBIO = false;
                callbackRespostaBIO = null;
                resolve({ sucesso: false, mensagem: 'Timeout - Biométrico não respondeu', bio_id: null });
            }
        }, timeout);
    });
}

// ==================== AUTENTICAÇÃO E ROTAS DE USUÁRIO ====================
const roleToTable = {
    'aluno': 'alunos',
    'admin_master': 'admin_master',
    'guarita': 'guarita',
    'admin_gestao': 'admin_gestao'
};

function autenticar(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ success: false, error: 'Não autenticado' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.usuario = decoded;
        next();
    } catch(err) {
        res.status(401).json({ success: false, error: 'Token inválido' });
    }
}

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const tables = [
        { nome: 'alunos', role: 'aluno' },
        { nome: 'admin_master', role: 'admin_master' },
        { nome: 'guarita', role: 'guarita' },
        { nome: 'admin_gestao', role: 'admin_gestao' }
    ];
    
    try {
        let userFound = null, roleFound = null;
        for (const t of tables) {
            try {
                const [rows] = await db.query(`SELECT id, name, email, password_hash FROM ${t.nome} WHERE email = ?`, [email]);
                if (rows.length) {
                    userFound = rows[0];
                    roleFound = t.role;
                    break;
                }
            } catch(e) { continue; }
        }
        if (!userFound) return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
        const valid = await bcrypt.compare(password, userFound.password_hash);
        if (!valid) return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
        const token = jwt.sign({ id: userFound.id, role: roleFound, name: userFound.name }, JWT_SECRET, { expiresIn: '8h' });
        res.cookie('token', token, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 8 * 3600000, path: '/' });
        res.json({ success: true, user: { id: userFound.id, name: userFound.name, email: userFound.email, role: roleFound } });
    } catch(err) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/me', autenticar, async (req, res) => {
    const table = roleToTable[req.usuario.role];
    const [rows] = await db.query(`SELECT id, name, email FROM ${table} WHERE id = ?`, [req.usuario.id]);
    const user = rows[0];
    user.role = req.usuario.role;
    res.json({ success: true, user, role: req.usuario.role });
});
app.get('/api/perfil/:id/:role', async (req, res) => {
    const { id, role } = req.params;
    const table = roleToTable[role];
    if (!table) return res.status(400).json({ success: false, error: 'Role inválida' });
    try {
        const [rows] = await db.query(`SELECT id, name, email FROM ${table} WHERE id = ?`, [id]);
        if (!rows.length) return res.status(404).json({ success: false });
        res.json({ success: true, user: rows[0] });
    } catch(err) { res.status(500).json({ success: false }); }
});

app.put('/api/perfil/:id/:role', async (req, res) => {
    const { id, role } = req.params;
    const { name, email } = req.body;
    const table = roleToTable[role];
    try {
        await db.query(`UPDATE ${table} SET name = ?, email = ? WHERE id = ?`, [name, email, id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false }); }
});

app.post('/api/alterar-senha', async (req, res) => {
    const { id, role, currentPassword, newPassword } = req.body;
    const table = roleToTable[role];
    try {
        const [rows] = await db.query(`SELECT password_hash FROM ${table} WHERE id = ?`, [id]);
        if (!rows.length) return res.status(404).json({ success: false });
        const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!valid) return res.status(401).json({ success: false, error: 'Senha atual incorreta' });
        const newHash = await bcrypt.hash(newPassword, 10);
        await db.query(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [newHash, id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false }); }
});

// ==================== ROTAS DE ALUNOS ====================
app.get('/api/alunos', autenticar, async (req, res) => {
    const alunos = await getAllAlunos();
    res.json(alunos);
});

app.get('/api/alunos/count', async (req, res) => {
    try {
        const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM alunos');
        res.json({ success: true, total: total });
    } catch (err) {
        console.error('[ERRO] /api/alunos/count:', err.message);
        res.json({ success: false, total: 0 });
    }
});

app.put('/api/alunos/:id', autenticar, async (req, res) => {
    const { id } = req.params;
    const { name, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, foto } = req.body;

    if (responsavel_telefone && !validarTelefoneWhatsApp(responsavel_telefone)) {
        return res.status(400).json({ sucesso: false, mensagem: 'Telefone do responsável inválido. Use apenas números com DDD (ex: 86999999999 ou 5586999999999).' });
    }

    try {
        await db.query(`UPDATE alunos SET name=?, matricula=?, ano=?, curso=?, responsavel_nome=?, responsavel_telefone=?, responsavel_email=?, foto=? WHERE id=?`, [name, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, foto, id]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Dados atualizados com sucesso!' });
    } catch (err) {
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

// ==================== CADASTRO RFID ====================
app.post('/api/cadastrar', autenticar, async (req, res) => {
    try {
        const { nome, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, email_login, senha_login, foto } = req.body;
        
        if (!nome || !matricula || !ano || !curso) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome, matrícula, ano e curso são obrigatórios' });
        }
        
        const [existe] = await db.query('SELECT id FROM alunos WHERE matricula = ?', [matricula]);
        if (existe.length) {
            return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });
        }
        
        if (email_login) {
            const [emailExiste] = await db.query('SELECT id FROM alunos WHERE email = ?', [email_login]);
            if (emailExiste.length) {
                return res.status(400).json({ sucesso: false, mensagem: 'Email já cadastrado!' });
            }
        }
        
        if (responsavel_telefone && !validarTelefoneWhatsApp(responsavel_telefone)) {
            return res.status(400).json({ sucesso: false, mensagem: 'Telefone do responsável inválido. Use apenas números com DDD (ex: 86999999999 ou 5586999999999).' });
        }
        
        broadcastStatusCadastro('Aproxime a tag RFID do leitor...', 'info', 'RFID');
        const resultado = await enviarComandoRFID(`CADASTRAR:${nome}`);
        
        if (!resultado.sucesso) {
            return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        }
        
        const rfid_uid = resultado.uid || null;
        
        let password_hash = null;
        if (senha_login && senha_login.length >= 6) {
            password_hash = await bcrypt.hash(senha_login, 10);
        }
        
        await db.query(`
            INSERT INTO alunos (name, matricula, ano, curso, tipo_acesso, rfid_uid, 
            responsavel_nome, responsavel_telefone, responsavel_email, email, password_hash, data_cadastro, foto) 
            VALUES (?, ?, ?, ?, 'RFID', ?, ?, ?, ?, ?, ?, NOW(), ?)
        `, [nome, matricula, ano, curso, rfid_uid, responsavel_nome, responsavel_telefone, responsavel_email, email_login, password_hash, foto]);

        if (responsavel_telefone && email_login && senha_login) {
            const linkPortal = `${process.env.APP_URL}${process.env.PORTAL_PAIS_PATH || '/portal/pais'}`;
            await addToQueue({
                tipo: 'cadastro',
                destinatario: responsavel_telefone,
                dados: {
                    nomeResponsavel: responsavel_nome || 'Responsável',
                    login: email_login,
                    senha: senha_login,
                    linkPortal: linkPortal
                }
            });
            await addToQueue({
                tipo: 'instrucoes',
                destinatario: responsavel_telefone,
                dados: {}
            });
        }

        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Aluno cadastrado com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor' });
    }
});

// ==================== CADASTRO BIOMÉTRICO ====================
app.post('/api/cadastrar-digital', autenticar, async (req, res) => {
    try {
        const { nome, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, email_login, senha_login, foto } = req.body;
        
        if (!nome || !matricula) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome e matrícula obrigatórios' });
        }
        
        const [existe] = await db.query('SELECT id FROM alunos WHERE matricula = ?', [matricula]);
        if (existe.length) {
            return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });
        }
        
        if (email_login) {
            const [emailExiste] = await db.query('SELECT id FROM alunos WHERE email = ?', [email_login]);
            if (emailExiste.length) {
                return res.status(400).json({ sucesso: false, mensagem: 'Email já cadastrado!' });
            }
        }
        
        if (responsavel_telefone && !validarTelefoneWhatsApp(responsavel_telefone)) {
            return res.status(400).json({ sucesso: false, mensagem: 'Telefone do responsável inválido. Use apenas números com DDD (ex: 86999999999 ou 5586999999999).' });
        }
        
        broadcastStatusCadastro('Iniciando cadastro biométrico... Coloque o dedo no sensor', 'info', 'BIO');
        const resultado = await enviarComandoBIO(`bio:Cadastrar:${nome}`);
        
        if (!resultado.sucesso) {
            return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        }
        
        const bio_id = resultado.bio_id || null;
        
        let password_hash = null;
        if (senha_login && senha_login.length >= 6) {
            password_hash = await bcrypt.hash(senha_login, 10);
        }
        
        await db.query(`
            INSERT INTO alunos (name, matricula, ano, curso, tipo_acesso, bio_id, 
            responsavel_nome, responsavel_telefone, responsavel_email, email, password_hash, data_cadastro, foto) 
            VALUES (?, ?, ?, ?, 'BIO', ?, ?, ?, ?, ?, ?, NOW(), ?)
        `, [nome, matricula, ano || 'N/A', curso || 'N/A', bio_id, responsavel_nome || null, responsavel_telefone || null, responsavel_email || null, email_login, password_hash, foto || null]);

        if (responsavel_telefone && email_login && senha_login) {
            const linkPortal = `${process.env.APP_URL}${process.env.PORTAL_PAIS_PATH || '/portal/pais'}`;
            await addToQueue({
                tipo: 'cadastro',
                destinatario: responsavel_telefone,
                dados: {
                    nomeResponsavel: responsavel_nome || 'Responsável',
                    login: email_login,
                    senha: senha_login,
                    linkPortal: linkPortal
                }
            });
            await addToQueue({
                tipo: 'instrucoes',
                destinatario: responsavel_telefone,
                dados: {}
            });
        }

        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Digital cadastrada com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar-digital:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

// ==================== REMOÇÕES, LIMPEZAS ====================
app.post('/api/remover-aluno', autenticar, async (req, res) => {
    try {
        const { matricula } = req.body;
        const [aluno] = await db.query('SELECT id, name, rfid_uid, tipo_acesso FROM alunos WHERE matricula = ?', [matricula]);
        if (!aluno.length) return res.status(404).json({ sucesso: false, mensagem: 'Aluno não encontrado' });
        
        if (aluno[0].rfid_uid) {
            console.log(`[RFID] Removendo: ${aluno[0].name}`);
            await enviarComandoRFID(`REMOVER:${aluno[0].name}`);
        }
        
        if (aluno[0].tipo_acesso === 'BIO' || aluno[0].tipo_acesso === 'AMBOS') {
            const [bioId] = await db.query('SELECT bio_id FROM alunos WHERE matricula = ?', [matricula]);
            if (bioId[0]?.bio_id) {
                console.log(`[BIO] Removendo digital do aluno ${aluno[0].name} com bio_id: ${bioId[0].bio_id}`);
                await enviarComandoBIO(`bio:Deletar:${bioId[0].bio_id}`);
            }
        }
        
        await db.query('DELETE FROM alunos WHERE matricula = ?', [matricula]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: `Aluno ${aluno[0].name} removido!` });
    } catch (err) {
        console.error('[ERRO] /api/remover-aluno:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/remover-digital', autenticar, async (req, res) => {
    try {
        const { matricula } = req.body;
        const [aluno] = await db.query('SELECT id, name, bio_id FROM alunos WHERE matricula = ?', [matricula]);
        if (!aluno.length) return res.status(404).json({ sucesso: false, mensagem: 'Digital não encontrada' });
        
        if (!aluno[0].bio_id) {
            return res.status(404).json({ sucesso: false, mensagem: 'Aluno não possui biometria cadastrada' });
        }
        
        console.log(`[BIO] Removendo digital: ${aluno[0].name} com bio_id: ${aluno[0].bio_id}`);
        const resultado = await enviarComandoBIO(`bio:Deletar:${aluno[0].bio_id}`);
        
        if (!resultado.sucesso) {
            return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        }
        
        await db.query('DELETE FROM alunos WHERE matricula = ?', [matricula]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: `Digital de ${aluno[0].name} removida!` });
    } catch (err) {
        console.error('[ERRO] /api/remover-digital:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/limpar', autenticar, async (req, res) => {
    await enviarComandoRFID('LIMPAR:TODOS');
    await db.query('DELETE FROM alunos');
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: 'Todos os alunos removidos!' });
});

app.post('/api/limpar-digitais', autenticar, async (req, res) => {
    try {
        console.log('[BIO] Limpando todas as digitais do sensor...');
        const resultado = await enviarComandoBIO('bio:Limpar');
        
        if (!resultado.sucesso) {
            return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        }
        
        await db.query("UPDATE alunos SET bio_id = NULL, tipo_acesso = 'RFID' WHERE bio_id IS NOT NULL");
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Todas as digitais removidas do sensor e do banco!' });
    } catch (err) {
        console.error('[ERRO] /api/limpar-digitais:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/limpar-tudo', autenticar, async (req, res) => {
    try {
        await enviarComandoRFID('LIMPAR:TODOS');
        await enviarComandoBIO('bio:Limpar');
        await db.query('DELETE FROM alunos');
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Todos os dados removidos do sistema e dos sensores!' });
    } catch (err) {
        console.error('[ERRO] /api/limpar-tudo:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/cadastrar-base', autenticar, async (req, res) => {
    const { nome, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email } = req.body;
    try {
        const [existe] = await db.query('SELECT id FROM alunos WHERE matricula = ?', [matricula]);
        if (existe.length) return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });
        await db.query(`INSERT INTO alunos (name, matricula, ano, curso, tipo_acesso, responsavel_nome, responsavel_telefone, responsavel_email, data_cadastro) VALUES (?, ?, ?, ?, 'AMBOS', ?, ?, ?, NOW())`, [nome, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email]);
        res.json({ sucesso: true, mensagem: 'Base do aluno criada!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/cadastrar-rfid', autenticar, async (req, res) => {
    const { matricula } = req.body;
    try {
        const [aluno] = await db.query('SELECT id, name, tipo_acesso, rfid_uid FROM alunos WHERE matricula = ?', [matricula]);
        if (!aluno.length) return res.status(404).json({ sucesso: false, mensagem: 'Aluno não encontrado' });
        if (aluno[0].rfid_uid) return res.status(400).json({ sucesso: false, mensagem: 'Aluno já possui RFID cadastrado' });
        broadcastStatusCadastro('Aproxime a tag RFID...', 'info', 'RFID');
        const resultado = await enviarComandoRFID(`CADASTRAR:${aluno[0].name}`);
        if (!resultado.sucesso) return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        const rfid_uid = resultado.uid;
        let tipoNovo = aluno[0].tipo_acesso;
        if (tipoNovo === 'BIO') tipoNovo = 'AMBOS';
        else if (!tipoNovo || tipoNovo === 'RFID') tipoNovo = 'RFID';
        await db.query('UPDATE alunos SET rfid_uid = ?, tipo_acesso = ? WHERE matricula = ?', [rfid_uid, tipoNovo, matricula]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'RFID associado com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar-rfid:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor' });
    }
});

app.post('/api/adicionar-biometria', autenticar, async (req, res) => {
    const { matricula } = req.body;
    try {
        const [aluno] = await db.query('SELECT id, name, tipo_acesso, bio_id FROM alunos WHERE matricula = ?', [matricula]);
        if (!aluno.length) return res.status(404).json({ sucesso: false, mensagem: 'Aluno não encontrado' });
        if (aluno[0].bio_id) return res.status(400).json({ sucesso: false, mensagem: 'Aluno já possui biometria cadastrada' });
        broadcastStatusCadastro('Inicie o cadastro biométrico no sensor...', 'info', 'BIO');
        const resultado = await enviarComandoBIO(`bio:Cadastrar:${aluno[0].name}`);
        if (!resultado.sucesso) return res.status(400).json({ sucesso: false, mensagem: resultado.mensagem });
        const bio_id = resultado.bio_id;
        let tipoNovo = aluno[0].tipo_acesso;
        if (tipoNovo === 'RFID') tipoNovo = 'AMBOS';
        else if (!tipoNovo || tipoNovo === 'BIO') tipoNovo = 'BIO';
        await db.query('UPDATE alunos SET bio_id = ?, tipo_acesso = ? WHERE matricula = ?', [bio_id, tipoNovo, matricula]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Biometria adicionada com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/adicionar-biometria:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor' });
    }
});

// ==================== CADASTRO AMBOS (RFID + BIOMETRIA) ====================
app.post('/api/cadastrar-ambos', autenticar, async (req, res) => {
    try {
        const { nome, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, email_login, senha_login, foto } = req.body;
        
        if (!nome || !matricula) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome e matrícula obrigatórios' });
        }
        
        const [existe] = await db.query('SELECT id FROM alunos WHERE matricula = ?', [matricula]);
        if (existe.length) {
            return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });
        }
        
        if (email_login) {
            const [emailExiste] = await db.query('SELECT id FROM alunos WHERE email = ?', [email_login]);
            if (emailExiste.length) {
                return res.status(400).json({ sucesso: false, mensagem: 'Email já cadastrado!' });
            }
        }
        
        if (responsavel_telefone && !validarTelefoneWhatsApp(responsavel_telefone)) {
            return res.status(400).json({ sucesso: false, mensagem: 'Telefone do responsável inválido. Use apenas números com DDD (ex: 86999999999 ou 5586999999999).' });
        }
        
        let password_hash = null;
        if (senha_login && senha_login.length >= 6) {
            password_hash = await bcrypt.hash(senha_login, 10);
        }
        
        const [result] = await db.query(`
            INSERT INTO alunos (name, matricula, ano, curso, tipo_acesso, 
            responsavel_nome, responsavel_telefone, responsavel_email, email, password_hash, data_cadastro, foto) 
            VALUES (?, ?, ?, ?, 'AMBOS', ?, ?, ?, ?, ?, NOW(), ?)
        `, [nome, matricula, ano || 'N/A', curso || 'N/A', responsavel_nome || null, responsavel_telefone || null, responsavel_email || null, email_login, password_hash, foto || null]);

        if (responsavel_telefone && email_login && senha_login) {
            const linkPortal = `${process.env.APP_URL}${process.env.PORTAL_PAIS_PATH || '/portal/pais'}`;
            await addToQueue({
                tipo: 'cadastro',
                destinatario: responsavel_telefone,
                dados: {
                    nomeResponsavel: responsavel_nome || 'Responsável',
                    login: email_login,
                    senha: senha_login,
                    linkPortal: linkPortal
                }
            });
            await addToQueue({
                tipo: 'instrucoes',
                destinatario: responsavel_telefone,
                dados: {}
            });
        }

        const alunoId = result.insertId;
        let rfid_uid = null, bio_id = null;
        
        if (serialPortRFID && serialPortRFID.isOpen) {
            broadcastStatusCadastro('Aproxime a tag RFID...', 'info', 'RFID');
            const resultadoRFID = await enviarComandoRFID(`CADASTRAR:${nome}`);
            if (resultadoRFID.sucesso) {
                rfid_uid = resultadoRFID.uid;
                await db.query('UPDATE alunos SET rfid_uid = ? WHERE id = ?', [rfid_uid, alunoId]);
            }
        }
        
        if (serialPortBIO && serialPortBIO.isOpen) {
            broadcastStatusCadastro('Iniciando cadastro biométrico...', 'info', 'BIO');
            const resultadoBIO = await enviarComandoBIO(`bio:Cadastrar:${nome}`);
            if (resultadoBIO.sucesso) {
                bio_id = resultadoBIO.bio_id;
                await db.query('UPDATE alunos SET bio_id = ? WHERE id = ?', [bio_id, alunoId]);
            }
        }
        
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Aluno cadastrado com RFID e/ou biometria!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar-ambos:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

// ==================== ROTAS AUXILIARES ====================
app.get('/api/debug/acessos/:nome', autenticar, async (req, res) => {
    const { nome } = req.params;
    try {
        const [acessos] = await db.query(
            'SELECT * FROM logs_acessos WHERE nome_aluno = ? ORDER BY data DESC, hora DESC LIMIT 50',
            [nome]
        );
        res.json({ sucesso: true, acessos });
    } catch(err) {
        res.json({ sucesso: false, erro: err.message });
    }
});

app.get('/api/status', autenticar, async (req, res) => {
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM alunos');
    const [[{ totalBio }]] = await db.query("SELECT COUNT(*) as totalBio FROM alunos WHERE tipo_acesso IN ('BIO','AMBOS') AND bio_id IS NOT NULL");
    res.json({ rfidConectado: serialPortRFID && serialPortRFID.isOpen, biometricoConectado: serialPortBIO && serialPortBIO.isOpen, totalAlunos: total, totalDigitais: totalBio, escola: { estado: statusEscola.estado, alunosPresentes: statusEscola.alunosPresentes.size } });
});

app.get('/api/escola/status', autenticar, (req, res) => {
    res.json({
        estado: statusEscola.estado,
        ultimaMudanca: statusEscola.ultimaMudanca,
        alunosPresentes: statusEscola.alunosPresentes.size,
        horarioEntrada: statusEscola.horarioEntrada,
        horarioSaida: statusEscola.horarioSaida,
        horarioFechamento: statusEscola.horarioFechamento,
        horarioLimiteEntrada: statusEscola.horarioLimiteEntrada,
        horarioLimiteAtivo: horarioLimiteAtivo
    });
});

app.post('/api/escola/alterar-status', autenticar, (req, res) => {
    const { novoStatus } = req.body;
    if (!['ABERTA', 'SAIDA', 'FECHADA'].includes(novoStatus)) return res.status(400).json({ sucesso: false, mensagem: 'Status inválido' });
    statusEscola.estado = novoStatus;
    statusEscola.ultimaMudanca = new Date().toLocaleString('pt-BR');
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: `Escola alterada para ${novoStatus}` });
});

// ==================== MODOS ESPECIAIS ====================
app.post('/api/modo-especial/saida-justificada', autenticar, (req, res) => {
    console.log('[MODO ESPECIAL] Requisição recebida: SAIDA_JUSTIFICADA');
    if (req.usuario.role !== 'guarita') {
        console.log('[MODO ESPECIAL] Acesso negado - role:', req.usuario.role);
        return res.status(403).json({ sucesso: false, mensagem: 'Acesso negado. Você não é da guarita.' });
    }
    const { motivo, autorizadoPor } = req.body;
    if (!motivo || !autorizadoPor) {
        console.log('[MODO ESPECIAL] Dados incompletos:', { motivo, autorizadoPor });
        return res.status(400).json({ sucesso: false, mensagem: 'Motivo e autorizador são obrigatórios' });
    }

    if (modoEspecial.timeout) clearTimeout(modoEspecial.timeout);

    modoEspecial.ativo = true;
    modoEspecial.tipo = 'SAIDA_JUSTIFICADA';
    modoEspecial.motivo = motivo;
    modoEspecial.autorizadoPor = autorizadoPor;

    modoEspecial.timeout = setTimeout(() => {
        console.log('[MODO ESPECIAL] Timeout atingido, cancelando stand-by');
        resetarModoEspecial();
    }, 60000);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                tipo: 'MODO_ESPECIAL_STATUS',
                ativo: true,
                tipoModo: 'SAIDA_JUSTIFICADA',
                motivo,
                autorizadoPor
            }));
        }
    });

    console.log('[MODO ESPECIAL] Stand-by ativado para SAIDA_JUSTIFICADA');
    res.json({ sucesso: true, mensagem: 'Stand-by ativo. Aguardando próximo RFID.' });
});

app.post('/api/modo-especial/entrada-atrasada', autenticar, (req, res) => {
    console.log('[MODO ESPECIAL] Requisição recebida: ENTRADA_ATRASADA');
    if (req.usuario.role !== 'guarita') {
        console.log('[MODO ESPECIAL] Acesso negado - role:', req.usuario.role);
        return res.status(403).json({ sucesso: false, mensagem: 'Acesso negado. Você não é da guarita.' });
    }
    const { motivo, autorizadoPor } = req.body;
    if (!motivo || !autorizadoPor) {
        console.log('[MODO ESPECIAL] Dados incompletos:', { motivo, autorizadoPor });
        return res.status(400).json({ sucesso: false, mensagem: 'Motivo e autorizador são obrigatórios' });
    }

    if (modoEspecial.timeout) clearTimeout(modoEspecial.timeout);

    modoEspecial.ativo = true;
    modoEspecial.tipo = 'ENTRADA_ATRASADA';
    modoEspecial.motivo = motivo;
    modoEspecial.autorizadoPor = autorizadoPor;

    modoEspecial.timeout = setTimeout(() => {
        console.log('[MODO ESPECIAL] Timeout atingido, cancelando stand-by');
        resetarModoEspecial();
    }, 60000);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                tipo: 'MODO_ESPECIAL_STATUS',
                ativo: true,
                tipoModo: 'ENTRADA_ATRASADA',
                motivo,
                autorizadoPor
            }));
        }
    });

    console.log('[MODO ESPECIAL] Stand-by ativado para ENTRADA_ATRASADA');
    res.json({ sucesso: true, mensagem: 'Stand-by ativo. Aguardando próximo RFID.' });
});

app.get('/api/modo-especial/status', autenticar, (req, res) => {
    res.json({
        sucesso: true,
        ativo: modoEspecial.ativo,
        tipo: modoEspecial.tipo,
        motivo: modoEspecial.motivo,
        autorizadoPor: modoEspecial.autorizadoPor
    });
});

app.post('/api/modo-especial/cancelar', autenticar, (req, res) => {
    if (req.usuario.role !== 'guarita') return res.status(403).json({ sucesso: false });
    resetarModoEspecial();
    res.json({ sucesso: true, mensagem: 'Stand-by cancelado.' });
});

app.post('/api/escola/simular-horario', autenticar, async (req, res) => {
    try {
        const { acao } = req.body;
        let novoStatus;
        switch (acao) {
            case 'abertura': novoStatus = 'ABERTA'; break;
            case 'saida': novoStatus = 'SAIDA'; break;
            case 'fechamento': novoStatus = 'FECHADA'; break;
            default: return res.status(400).json({ sucesso: false, mensagem: 'Ação inválida' });
        }
        statusEscola.estado = novoStatus;
        statusEscola.ultimaMudanca = new Date().toLocaleString('pt-BR');
        console.log(`[ESCOLA] Estado alterado para: ${novoStatus}`);
        broadcastStatus();
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: `Simulação: escola ${novoStatus}` });
    } catch (error) {
        console.error('[ERRO] simular-horario:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

// ==================== CONFIGURAÇÕES DE HORÁRIO LIMITE ====================
app.get('/api/config/horario-limite', autenticar, async (req, res) => {
    try {
        const [cfg] = await db.query(`SELECT valor FROM configuracoes_sistema WHERE chave = 'horario_limite_ativo'`);
        const ativo = cfg.length ? cfg[0].valor === 'true' : true;
        res.json({ success: true, ativo });
    } catch (err) {
        res.status(500).json({ success: false, mensagem: err.message });
    }
});

app.post('/api/config/horario-limite', autenticar, async (req, res) => {
    const { ativo } = req.body;
    if (typeof ativo !== 'boolean') {
        return res.status(400).json({ success: false, mensagem: 'Valor inválido' });
    }
    try {
        await db.query(`UPDATE configuracoes_sistema SET valor = ? WHERE chave = 'horario_limite_ativo'`, [ativo ? 'true' : 'false']);
        horarioLimiteAtivo = ativo;
        console.log(`[CONFIG] Horário limite de entrada ${ativo ? 'ATIVADO' : 'DESATIVADO'} (persistido)`);
        broadcastStatus();
        res.json({ success: true, ativo: horarioLimiteAtivo });
    } catch (err) {
        res.status(500).json({ success: false, mensagem: err.message });
    }
});
app.get('/api/escola/presentes', autenticar, async (req, res) => {
    const ids = Array.from(statusEscola.alunosPresentes);
    if (!ids.length) return res.json({ totalPresentes: 0, alunosPresentes: [] });
    const placeholders = ids.map(() => '?').join(',');
    const [alunos] = await db.query(`SELECT a.name, a.matricula, a.ano, a.curso, p.entrada FROM alunos a LEFT JOIN presencas p ON p.aluno_id = a.id AND p.data = CURDATE() WHERE a.id IN (${placeholders})`, [...ids]);
    res.json({ totalPresentes: alunos.length, alunosPresentes: alunos });
});

app.get('/api/ultimo-acesso', autenticar, (req, res) => {
    const ultimo = historicoAcessos.length ? historicoAcessos[0] : null;
    res.json({ sucesso: true, acesso: ultimo });
});

// ==================== ADMIN GESTÃO ====================
app.get('/api/admin/gestao/listar', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_master') {
            return res.status(403).json({ sucesso: false, mensagem: 'Acesso negado' });
        }
        const [rows] = await db.query('SELECT id, name, email, ativo, DATE_FORMAT(criado_em, "%d/%m/%Y %H:%i") as criado_em FROM admin_gestao ORDER BY criado_em DESC');
        res.json({ sucesso: true, admins: rows });
    } catch (error) {
        res.status(500).json({ sucesso: false, mensagem: error.message });
    }
});

app.post('/api/admin/gestao/criar', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_master') {
            return res.status(403).json({ sucesso: false, mensagem: 'Apenas Admin Master pode criar' });
        }
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome, email e senha são obrigatórios' });
        }
        if (senha.length < 6) {
            return res.status(400).json({ sucesso: false, mensagem: 'A senha deve ter no mínimo 6 caracteres' });
        }
        const [existe] = await db.query('SELECT id FROM admin_gestao WHERE email = ?', [email]);
        if (existe.length > 0) {
            return res.status(400).json({ sucesso: false, mensagem: 'Este email já está cadastrado' });
        }
        const hash = await bcrypt.hash(senha, 10);
        await db.query('INSERT INTO admin_gestao (name, email, password_hash, criado_por, criado_em, ativo) VALUES (?, ?, ?, ?, NOW(), 1)', [nome, email, hash, req.usuario.id]);
        res.json({ sucesso: true, mensagem: `Admin de Gestão "${nome}" criado com sucesso!` });
    } catch (error) {
        console.error('Erro ao criar admin:', error);
        res.status(500).json({ sucesso: false, mensagem: error.message });
    }
});

app.delete('/api/admin/gestao/:id', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_master') {
            return res.status(403).json({ sucesso: false, mensagem: 'Acesso negado' });
        }
        await db.query('DELETE FROM admin_gestao WHERE id = ?', [req.params.id]);
        res.json({ sucesso: true, mensagem: 'Administrador removido!' });
    } catch (error) {
        res.status(500).json({ sucesso: false, mensagem: error.message });
    }
});

// ==================== HISTÓRICO E PRESENÇAS ====================
app.get('/api/historico-acessos', autenticar, async (req, res) => {
    try {
        const { data, aprovado, limite } = req.query;
        let sql = 'SELECT * FROM logs_acessos WHERE 1=1';
        const params = [];
        
        const dataFiltro = data || new Date().toISOString().slice(0, 10);
        sql += ' AND data = ?';
        params.push(dataFiltro);
        
        if (aprovado !== undefined) { sql += ' AND aprovado = ?'; params.push(parseInt(aprovado)); }
        
        const lim = parseInt(limite) || 1000;
        sql += ' ORDER BY id DESC LIMIT ?';
        params.push(lim);
        
        const [rows] = await db.query(sql, params);
        res.json({ sucesso: true, acessos: rows });
    } catch (err) {
        console.error('[ERRO] /api/historico-acessos:', err.message);
        res.status(500).json({ sucesso: false, acessos: [] });
    }
});

// ==================== ROTA /api/presencas CORRIGIDA (com DATE_FORMAT) ====================
app.get('/api/presencas', autenticar, async (req, res) => {
    try {
        let sql = `
            SELECT 
                p.id,
                a.name AS nome_aluno,
                a.matricula,
                a.curso,
                a.ano,
                CONCAT(a.ano, '° ', a.curso) AS turma,
                DATE_FORMAT(p.data, '%Y-%m-%d') AS data,
                p.entrada,
                p.saida,
                p.tipo_sistema,
                p.status,
                p.tipo_liberacao
            FROM presencas p
            JOIN alunos a ON p.aluno_id = a.id
            WHERE 1=1
        `;
        const params = [];

        if (req.query.data) {
            sql += ' AND p.data = ?';
            params.push(req.query.data);
        }
        if (req.query.nome) {
            sql += ' AND a.name LIKE ?';
            params.push(`%${req.query.nome}%`);
        }
        if (req.query.curso) {
            sql += ' AND a.curso = ?';
            params.push(req.query.curso);
        }
        if (req.query.turma) {
            sql += ' AND CONCAT(a.ano, "° ", a.curso) = ?';
            params.push(req.query.turma);
        }
        if (req.query.tipo_sistema) {
            sql += ' AND p.tipo_sistema = ?';
            params.push(req.query.tipo_sistema);
        }

        sql += ' ORDER BY p.data DESC, p.entrada DESC';

        if (req.query.limite) {
            sql += ' LIMIT ?';
            params.push(parseInt(req.query.limite));
        } else {
            sql += ' LIMIT 500';
        }

        const [rows] = await db.query(sql, params);
        res.json({ sucesso: true, presencas: rows });
    } catch (err) {
        console.error('[ERRO] /api/presencas:', err.message);
        res.status(500).json({ sucesso: false, presencas: [] });
    }
});

// ==================== ROTAS PARA O ALUNO ====================
app.get('/api/minhas-presencas', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'aluno') {
            return res.status(403).json({ sucesso: false, presencas: [] });
        }
        
        const [rows] = await db.query(`
            SELECT 
                p.id,
                p.data,
                p.entrada,
                p.saida,
                p.status,
                p.tipo_sistema,
                a.name AS nome_aluno,
                a.matricula,
                a.curso,
                a.ano
            FROM presencas p
            JOIN alunos a ON p.aluno_id = a.id
            WHERE a.id = ?
            ORDER BY p.data DESC, p.entrada DESC
            LIMIT 500
        `, [req.usuario.id]);
        
        res.json({ sucesso: true, presencas: rows });
    } catch (err) {
        console.error('[ERRO] /api/minhas-presencas:', err.message);
        res.status(500).json({ sucesso: false, presencas: [] });
    }
});

app.get('/api/aluno/perfil', autenticar, async (req, res) => {
    if (req.usuario.role !== 'aluno') {
        return res.status(403).json({ sucesso: false });
    }
    try {
        const [rows] = await db.query(`
            SELECT 
                id, 
                name, 
                matricula, 
                ano, 
                curso, 
                tipo_acesso, 
                foto,
                data_cadastro,
                responsavel_nome,
                responsavel_telefone,
                responsavel_email,
                email
            FROM alunos 
            WHERE id = ?
        `, [req.usuario.id]);
        
        if (!rows.length) return res.status(404).json({ sucesso: false });
        res.json({ sucesso: true, aluno: rows[0] });
    } catch (err) {
        console.error('[ERRO] /api/aluno/perfil:', err);
        res.status(500).json({ sucesso: false });
    }
});

// ==================== ADMIN MASTER ====================
app.get('/api/admin-master/stats', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_master') return res.status(403).json({ success: false });
    try {
        const [[{ totalAlunos }]] = await db.query("SELECT COUNT(*) as total FROM alunos");
        const [[{ totalAdminMaster }]] = await db.query("SELECT COUNT(*) as total FROM admin_master");
        const [[{ totalGuarita }]] = await db.query("SELECT COUNT(*) as total FROM guarita");
        let totalAdminGestao = 0;
        try { const [[{ total }]] = await db.query("SELECT COUNT(*) as total FROM admin_gestao"); totalAdminGestao = total; } catch(e) {}
        res.json({ success: true, alunos: totalAlunos, admin_master: totalAdminMaster, guarita: totalGuarita, admin_gestao: totalAdminGestao });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});
// Rota pública para contagem de usuários (usada no dashboard master)
app.get('/api/stats-publicos', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_master') {
        return res.status(403).json({ success: false });
    }
    try {
        const [[{ total: admin_master }]] = await db.query("SELECT COUNT(*) as total FROM admin_master");
        const [[{ total: admin_gestao }]] = await db.query("SELECT COUNT(*) as total FROM admin_gestao");
        const [[{ total: guarita }]] = await db.query("SELECT COUNT(*) as total FROM guarita");
        const [[{ total: alunos }]] = await db.query("SELECT COUNT(*) as total FROM alunos");
        res.json({ success: true, admin_master, admin_gestao, guarita, alunos });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin-master/users', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_master') return res.status(403).json({ success: false });
    try {
        const [alunos] = await db.query("SELECT id, name, email, 'aluno' as tipo FROM alunos");
        const [admins] = await db.query("SELECT id, name, email, 'admin_master' as tipo FROM admin_master");
        const [guaritas] = await db.query("SELECT id, name, email, 'guarita' as tipo FROM guarita");
        let adminGestao = [];
        try { adminGestao = await db.query("SELECT id, name, email, 'admin_gestao' as tipo FROM admin_gestao"); } catch(e) {}
        const allUsers = [...alunos, ...admins, ...guaritas, ...(adminGestao[0] || [])];
        res.json({ success: true, data: allUsers });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao buscar usuários' });
    }
});

app.post('/api/admin-master/create-user', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_master') return res.status(403).json({ success: false });
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ success: false, error: 'Dados incompletos' });
    const tableMap = { aluno: 'alunos', admin_master: 'admin_master', guarita: 'guarita', admin_gestao: 'admin_gestao' };
    const table = tableMap[role];
    if (!table) return res.status(400).json({ success: false, error: 'Role inválida' });
    try {
        const [exists] = await db.query(`SELECT id FROM ${table} WHERE email = ?`, [email]);
        if (exists.length) return res.status(400).json({ success: false, error: 'E-mail já existe' });
        const hash = await bcrypt.hash(password, 10);
        await db.query(`INSERT INTO ${table} (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, hash]);
        res.json({ success: true, message: 'Usuário criado com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao criar' });
    }
});

app.delete('/api/admin-master/user/:tipo/:id', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_master') return res.status(403).json({ success: false });
    const { tipo, id } = req.params;
    const tableMap = { aluno: 'alunos', admin_master: 'admin_master', guarita: 'guarita', admin_gestao: 'admin_gestao' };
    const table = tableMap[tipo];
    if (!table) return res.status(400).json({ success: false });
    try {
        await db.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// ==================== DASHBOARD DE GESTÃO ====================
app.get('/api/admin-gestao/stats', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        
        const [totalAlunosResult] = await db.query('SELECT COUNT(*) as total FROM alunos');
        const totalAlunos = totalAlunosResult[0].total;
        
        const [presentesResult] = await db.query(
    'SELECT COUNT(DISTINCT aluno_id) as total FROM presencas WHERE data = CURDATE() AND status = "PRESENTE" AND saida IS NULL'
);
        const presentesHoje = presentesResult[0].total || 0;
        
        const [mediaResult] = await db.query(`
            SELECT COUNT(DISTINCT data) as dias_com_presenca 
            FROM presencas 
            WHERE data >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `);
        const diasComPresenca = mediaResult[0].dias_com_presenca || 0;
        const mediaFrequencia = Math.round((diasComPresenca / 30) * 100);
        
        const [ativosResult] = await db.query(`
            SELECT COUNT(DISTINCT aluno_id) as total 
            FROM presencas 
            WHERE data >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `);
        const alunosAtivos = ativosResult[0].total || 0;
        
        res.json({
            success: true,
            stats: {
                totalAlunos,
                presentesHoje,
                mediaFrequencia,
                alunosAtivos
            }
        });
    } catch (error) {
        console.error('[ERRO] /api/admin-gestao/stats:', error);
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});

app.get('/api/ultimos-acessos', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        
        const [acessos] = await db.query(`
            SELECT 
                id,
                nome_aluno,
                matricula,
                aprovado,
                motivo,
                tipo_sistema,
                hora,
                data,
                created_at
            FROM logs_acessos 
            ORDER BY id DESC 
            LIMIT 20
        `);
        
        const acessosFormatados = acessos.map(acesso => ({
            id: acesso.id,
            nome_aluno: acesso.nome_aluno || 'Desconhecido',
            matricula: acesso.matricula || 'N/A',
            aprovado: acesso.aprovado === 1,
            motivo: acesso.motivo || '',
            metodo: acesso.tipo_sistema || 'RFID',
            tipo_acesso: acesso.aprovado ? (acesso.motivo?.includes('ENTRADA') ? 'entrada' : 'saida') : 'negado',
            horario_formatado: `${acesso.hora || '--:--'} - ${acesso.data || '--/--/----'}`,
            hora: acesso.hora,
            data: acesso.data,
            foto: null
        }));
        
        res.json({
            success: true,
            acessos: acessosFormatados
        });
    } catch (error) {
        console.error('[ERRO] /api/ultimos-acessos:', error);
        res.json({ success: true, acessos: [] });
    }
});

// ==================== ROTAS DE LIBERAÇÃO EM MASSA ====================
app.post('/api/liberar-acesso', autenticar, async (req, res) => {
    try {
        const { matricula, justificativa, horario } = req.body;
        if (!matricula || !justificativa) {
            return res.status(400).json({ success: false, message: 'Matrícula e justificativa são obrigatórios' });
        }
        const [alunoRows] = await db.query(
            'SELECT id, name, responsavel_telefone FROM alunos WHERE matricula = ?',
            [matricula]
        );
        if (!alunoRows.length) {
            return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
        }
        const aluno = alunoRows[0];
        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);

        await db.query(
            `INSERT INTO liberacoes (tipo, matricula, justificativa, autorizado_por, expires_at, horario_agendado)
             VALUES ('individual', ?, ?, ?, ?, ?)`,
            [matricula, justificativa, req.usuario.name, expiresAt, horario || null]
        );

        if (aluno.responsavel_telefone) {
            await addToQueue({
                tipo: 'liberacaoIndividual',
                destinatario: aluno.responsavel_telefone,
                dados: {
                    nomeAluno: aluno.name,
                    motivo: justificativa,
                    autorizadoPor: req.usuario.name,
                    horario: horario || null
                }
            });
        }

        broadcastAtualizacaoAlunos();
        res.json({ success: true, message: `Aluno ${aluno.name} liberado com sucesso!` });
    } catch (err) {
        console.error('[ERRO] /api/liberar-acesso:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao liberar acesso' });
    }
});

app.post('/api/liberar-turma', autenticar, async (req, res) => {
    try {
        let { turma, justificativa, horario } = req.body;
        if (!turma || !justificativa) {
            return res.status(400).json({ success: false, message: 'Turma e justificativa são obrigatórios' });
        }

        // Normalizar o nome da turma para o formato salvo no banco (ex: "3° Informatica" -> "3° Ano Informatica")
        let turmaCompleta = turma.trim();
        if (!turmaCompleta.includes('Ano')) {
            const partes = turmaCompleta.split(' ');
            const grau = partes[0]; // ex: "1°"
            const restoCurso = partes.slice(1).join(' ');
            turmaCompleta = `${grau} Ano ${restoCurso}`;
        }

        const [alunos] = await db.query(
            `SELECT a.id, a.name, a.responsavel_telefone 
             FROM alunos a
             WHERE CONCAT(a.ano, ' ', a.curso) = ?`,
            [turmaCompleta]
        );

        if (!alunos.length) {
            return res.status(404).json({ success: false, message: 'Nenhum aluno encontrado para esta turma' });
        }

        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);

        await db.query(
            `INSERT INTO liberacoes (tipo, turma_nome, justificativa, autorizado_por, expires_at, horario_agendado)
             VALUES ('turma', ?, ?, ?, ?, ?)`,
            [turmaCompleta, justificativa, req.usuario.name, expiresAt, horario || null]
        );

        const horarioTexto = horario || null;
        for (const aluno of alunos) {
            if (aluno.responsavel_telefone) {
                await addToQueue({
                    tipo: 'liberacaoTurma',
                    destinatario: aluno.responsavel_telefone,
                    dados: {
                        nomeAluno: aluno.name,
                        turma: turmaCompleta,
                        motivo: justificativa,
                        autorizadoPor: req.usuario.name,
                        horario: horarioTexto
                    }
                });
            }
        }

        broadcastAtualizacaoAlunos();
        res.json({ success: true, message: `Turma ${turma} liberada! Responsáveis notificados.` });
    } catch (err) {
        console.error('[ERRO] /api/liberar-turma:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao liberar turma' });
    }
});

app.get('/api/turmas', autenticar, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT DISTINCT 
                REPLACE(ano, '° Ano', '°') AS ano_limpo,
                curso
            FROM alunos
            WHERE ano IS NOT NULL AND curso IS NOT NULL AND ano != '' AND curso != ''
            ORDER BY ano_limpo, curso
        `);
        const turmas = rows.map(row => `${row.ano_limpo} ${row.curso}`);
        const turmasUnicas = [...new Set(turmas)];
        res.json({ success: true, turmas: turmasUnicas });
    } catch (err) {
        console.error('[ERRO] /api/turmas:', err);
        res.status(500).json({ success: false, turmas: [] });
    }
});

app.post('/api/liberar-escola', autenticar, async (req, res) => {
    try {
        const { justificativa, horario } = req.body;
        if (!justificativa) {
            return res.status(400).json({ success: false, message: 'Justificativa é obrigatória' });
        }
        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);

        await db.query(
            `INSERT INTO liberacoes (tipo, justificativa, autorizado_por, expires_at, horario_agendado)
             VALUES ('escola', ?, ?, ?, ?)`,
            [justificativa, req.usuario.name, expiresAt, horario || null]
        );

        const [todosAlunos] = await db.query(
            'SELECT name, responsavel_telefone FROM alunos WHERE responsavel_telefone IS NOT NULL AND responsavel_telefone != ""'
        );
        for (const aluno of todosAlunos) {
            await addToQueue({
                tipo: 'liberacaoTurma',
                destinatario: aluno.responsavel_telefone,
                dados: {
                    nomeAluno: aluno.name,
                    turma: 'Escola toda',
                    motivo: justificativa,
                    autorizadoPor: req.usuario.name,
                    horario: horario || null
                }
            });
        }

        broadcastAtualizacaoAlunos();
        res.json({ success: true, message: 'Escola toda liberada! Responsáveis notificados.' });
    } catch (err) {
        console.error('[ERRO] /api/liberar-escola:', err);
        res.status(500).json({ success: false, message: 'Erro interno ao liberar escola' });
    }
});

// ==================== ROTA DE LIBERAÇÃO SELETIVA (MÚLTIPLOS ALUNOS) ====================
app.post('/api/liberar-multiplos', autenticar, async (req, res) => {
    console.log('[LIBERAÇÃO MÚLTIPLA] Payload recebido:', req.body);
    try {
        const { matriculas, justificativa, horario, turma } = req.body;
        if (!matriculas || !matriculas.length || !justificativa) {
            return res.status(400).json({ success: false, message: 'Dados incompletos' });
        }
        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);
        let sucessos = 0;
        for (const matricula of matriculas) {
            const [aluno] = await db.query('SELECT name, responsavel_telefone FROM alunos WHERE matricula = ?', [matricula]);
            if (!aluno.length) continue;
            await db.query(
                `INSERT INTO liberacoes (tipo, matricula, justificativa, autorizado_por, expires_at, horario_agendado)
                 VALUES ('individual', ?, ?, ?, ?, ?)`,
                [matricula, justificativa, req.usuario.name, expiresAt, horario || null]
            );
            if (aluno[0].responsavel_telefone) {
                await addToQueue({
                    tipo: 'liberacaoIndividual',
                    destinatario: aluno[0].responsavel_telefone,
                    dados: { nomeAluno: aluno[0].name, motivo: justificativa, autorizadoPor: req.usuario.name, horario: horario || null }
                });
            }
            sucessos++;
        }
        broadcastAtualizacaoAlunos();
        res.json({ success: true, message: `${sucessos} aluno(s) liberado(s) seletivamente.` });
    } catch (err) {
        console.error('[ERRO] /api/liberar-multiplos:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==================== ROTA DE CANCELAR LIBERAÇÃO ====================
app.post('/api/cancelar-liberacao/:id', autenticar, async (req, res) => {
    try {
        const { id } = req.params;
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        await db.query('UPDATE liberacoes SET status = 0 WHERE id = ?', [id]);
        broadcastAtualizacaoAlunos();
        res.json({ success: true, message: 'Liberação cancelada com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cancelar-liberacao:', err);
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});

app.get('/api/liberacoes/detalhadas', autenticar, async (req, res) => {
    try {
        const [liberacoes] = await db.query(`
            SELECT 
                l.id, l.tipo, l.matricula, l.turma_nome, l.justificativa,
                l.autorizado_por, l.created_at, l.expires_at, l.status,
                l.horario_agendado,
                CASE 
    WHEN l.tipo = 'individual' THEN (
        SELECT COUNT(*) FROM presencas p2
        JOIN alunos a2 ON p2.aluno_id = a2.id
        WHERE a2.matricula = l.matricula
          AND p2.data = CURDATE()
          AND p2.saida IS NULL
          AND p2.status IN ('PRESENTE','LIBERADO')
    )
    WHEN l.tipo = 'turma' THEN (
        SELECT COUNT(DISTINCT a.id)
        FROM alunos a
        JOIN presencas p ON p.aluno_id = a.id
        WHERE CONCAT(a.ano, ' ', a.curso) = l.turma_nome
          AND p.data = CURDATE()
          AND p.saida IS NULL
          AND p.status IN ('PRESENTE','LIBERADO')
    )
    WHEN l.tipo = 'escola' THEN (
        SELECT COUNT(DISTINCT p.aluno_id)
        FROM presencas p
        WHERE p.data = CURDATE()
          AND p.saida IS NULL
          AND p.status IN ('PRESENTE','LIBERADO')
    )
END AS total_afetados
            FROM liberacoes l
            ORDER BY l.created_at DESC
        `);
        
        const agora = new Date();
        const liberacoesFormatadas = liberacoes.map(l => ({
            id: l.id,
            tipo: l.tipo,
            matricula: l.matricula,
            turma_nome: l.turma_nome,
            justificativa: l.justificativa,
            autorizado_por: l.autorizado_por,
            created_at: l.created_at,
            created_at_br: l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '-',
            expires_at_br: l.expires_at ? new Date(l.expires_at).toLocaleString('pt-BR') : '-',
            vigente: l.status === 1 && new Date(l.expires_at) > agora,
            alvo: l.tipo === 'individual' ? `Aluno: ${l.matricula}` :
                  l.tipo === 'turma' ? `Turma: ${l.turma_nome}` : 'Toda a escola',
            total_afetados: l.total_afetados || 0,
            horario_agendado: l.horario_agendado || null
        }));
        
        res.json({ success: true, liberacoes: liberacoesFormatadas });
    } catch (err) {
        console.error('[ERRO] /api/liberacoes/detalhadas:', err);
        res.status(500).json({ success: false, liberacoes: [] });
    }
});

app.get('/api/calendario', autenticar, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT *, DATE_FORMAT(horario_saida, "%H:%i") as horario_saida FROM calendario_escolar ORDER BY data');
        res.json({ success: true, eventos: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/calendario', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master')
        return res.status(403).json({ success: false, message: 'Acesso negado' });
    const { data, tipo, descricao, horario_saida } = req.body;
    if (!data || !tipo) return res.status(400).json({ success: false, message: 'Data e tipo obrigatórios' });
    try {
        if (tipo === 'sabado_letivo') {
            await db.query(
                `INSERT INTO calendario_escolar (data, tipo, descricao, horario_saida, criado_por)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                 tipo = VALUES(tipo),
                 descricao = VALUES(descricao),
                 horario_saida = VALUES(horario_saida),
                 criado_por = VALUES(criado_por)`,
                [data, tipo, descricao, horario_saida || null, req.usuario.name]
            );
        } else {
            await db.query(
                `INSERT INTO calendario_escolar (data, tipo, descricao, criado_por)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                 tipo = VALUES(tipo),
                 descricao = VALUES(descricao),
                 criado_por = VALUES(criado_por),
                 horario_saida = NULL`,
                [data, tipo, descricao, req.usuario.name]
            );
        }
        res.json({ success: true, message: 'Evento salvo!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/calendario/:id', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master')
        return res.status(403).json({ success: false, message: 'Acesso negado' });
    try {
        await db.query('DELETE FROM calendario_escolar WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Evento removido!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==================== ROTAS DE HORÁRIOS POR TURMA ====================
app.get('/api/horarios-turma', autenticar, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM horarios_turma ORDER BY turma_nome, dia_semana');
        res.json({ success: true, horarios: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/horarios-turma', autenticar, async (req, res) => {
    console.log('[HORARIOS] POST recebido:', req.body);
    if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master')
        return res.status(403).json({ success: false, message: 'Acesso negado' });
    const { turma_nome, dia_semana, horario_saida } = req.body;
    if (!turma_nome || dia_semana === undefined || !horario_saida)
        return res.status(400).json({ success: false, message: 'Dados incompletos' });
    try {
        console.log(`[HORARIOS] Turma: ${turma_nome}, Dia: ${dia_semana}, Horário: ${horario_saida}`);
        const [existe] = await db.query('SELECT id FROM horarios_turma WHERE turma_nome = ? AND dia_semana = ?', [turma_nome, dia_semana]);
        if (existe.length) {
            await db.query('UPDATE horarios_turma SET horario_saida = ?, criado_por = ? WHERE id = ?', [horario_saida, req.usuario.name, existe[0].id]);
            res.json({ success: true, message: 'Horário atualizado!' });
        } else {
            await db.query('INSERT INTO horarios_turma (turma_nome, dia_semana, horario_saida, criado_por) VALUES (?, ?, ?, ?)', [turma_nome, dia_semana, horario_saida, req.usuario.name]);
            res.json({ success: true, message: 'Horário cadastrado!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/horarios-turma/:id', autenticar, async (req, res) => {
    if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master')
        return res.status(403).json({ success: false, message: 'Acesso negado' });
    try {
        await db.query('DELETE FROM horarios_turma WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Horário removido!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// ==================== ROTAS PARA CONFIGURAÇÃO DE SÁBADOS ====================

// Listar configurações de sábados para um mês/ano
// Listar configurações de sábados para um mês/ano
app.get('/api/sabados', autenticar, async (req, res) => {
    try {
        // Permite acesso para admin_gestao, admin_master e aluno
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master' && req.usuario.role !== 'aluno') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        const { mes, ano, turma } = req.query;
        if (!mes || !ano) {
            return res.status(400).json({ success: false, message: 'Mês e ano são obrigatórios' });
        }
        let sql = `SELECT * FROM sabados_config WHERE MONTH(data) = ? AND YEAR(data) = ?`;
        const params = [mes, ano];
        
        // Se for aluno, busca apenas configurações da sua turma ou gerais (turma_nome IS NULL)
        if (req.usuario.role === 'aluno') {
            // Para aluno, não passamos o parâmetro turma pela query string
            // Buscamos configurações para a turma do aluno OU gerais
            // Precisamos primeiro obter a turma do aluno logado
            const [alunoRows] = await db.query('SELECT ano, curso FROM alunos WHERE id = ?', [req.usuario.id]);
            if (alunoRows.length) {
                let turmaAluno = `${alunoRows[0].ano} ${alunoRows[0].curso}`;
                // Normaliza para o formato salvo no banco (ex: "3° Ano Informatica")
                if (!turmaAluno.includes('Ano') && turmaAluno.match(/^\d+°/)) {
                    const partes = turmaAluno.split(' ');
                    const anoNum = partes[0];
                    const restante = partes.slice(1).join(' ');
                    turmaAluno = `${anoNum} Ano ${restante}`;
                }
                sql += ` AND (turma_nome = ? OR turma_nome IS NULL)`;
                params.push(turmaAluno);
            } else {
                sql += ` AND turma_nome IS NULL`;
            }
        } else {
            // Para admin, usa o parâmetro turma da query string
            if (turma && turma !== 'todas') {
                sql += ` AND (turma_nome = ? OR turma_nome IS NULL)`;
                params.push(turma);
            } else {
                sql += ` AND turma_nome IS NULL`;
            }
        }
        
        const [rows] = await db.query(sql, params);
        res.json({ success: true, configs: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Salvar configurações de vários sábados (lote)
app.post('/api/sabados', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        const { configs } = req.body;
        if (!configs || !Array.isArray(configs)) {
            return res.status(400).json({ success: false, message: 'Dados inválidos' });
        }
        await db.query('START TRANSACTION');
        for (const cfg of configs) {
            const { data, tipo, horario_entrada, horario_saida, bloqueio_entrada, justificativa, turma_nome } = cfg;
            if (!data || !tipo) {
    await db.query('ROLLBACK');
    return res.status(400).json({ success: false, message: 'Data e tipo são obrigatórios' });
}
if (tipo !== 'nao_letivo' && !horario_saida) {
    await db.query('ROLLBACK');
    return res.status(400).json({ success: false, message: 'Para este tipo, o horário de saída é obrigatório' });
}
            const entrada = tipo === 'nao_letivo' ? null : (horario_entrada || null);
            const bloqueio = tipo === 'nao_letivo' ? null : (bloqueio_entrada || null);
            const saida = tipo === 'nao_letivo' ? null : horario_saida;
            await db.query(`
                INSERT INTO sabados_config (data, turma_nome, tipo, horario_entrada, horario_saida, bloqueio_entrada, justificativa, criado_por)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    tipo = VALUES(tipo),
                    horario_entrada = VALUES(horario_entrada),
                    horario_saida = VALUES(horario_saida),
                    bloqueio_entrada = VALUES(bloqueio_entrada),
                    justificativa = VALUES(justificativa),
                    criado_por = VALUES(criado_por)
            `, [data, turma_nome || null, tipo, entrada, saida, bloqueio, justificativa || null, req.usuario.name]);
        }
        await db.query('COMMIT');
        res.json({ success: true, message: 'Configurações salvas com sucesso!' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'arduino-menu.html')));
app.get('/admin', autenticar, (req, res) => {
    if (!['admin_master', 'admin_gestao'].includes(req.usuario.role)) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/dashboard', autenticar, (req, res) => {
    if (req.usuario.role !== 'admin_master') {
        return res.status(403).send('Acesso negado. Você não tem permissão para visualizar esta página.');
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/acesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'acesso.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuracoes.html')));
app.get('/historico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'historico.html')));

// ==================== WEBSOCKET E INICIALIZAÇÃO DO SERVIDOR ====================
wss.on('connection', (ws) => {
    console.log('[WS] Cliente conectado');
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    if (historicoAcessos.length) broadcastUltimoAcesso(historicoAcessos[0]);
});

module.exports = { db };

// ========== WHATSAPP ==========
const { iniciarWhatsApp } = require('./src/services/whatsappClient');

app.post('/api/test-whatsapp', async (req, res) => {
    const { numero, texto } = req.body;
    const { addToQueue } = require('./src/queues/whatsappQueue');
    await addToQueue({
        tipo: 'teste',
        destinatario: numero,
        dados: { textoPersonalizado: texto }
    });
    res.json({ success: true });
});

async function seedFeriados(ano) {
    const feriados = [
        { data: `${ano}-01-01`, tipo: 'feriado_nacional', descricao: 'Confraternização Universal' },
        { data: `${ano}-04-21`, tipo: 'feriado_nacional', descricao: 'Tiradentes' },
        { data: `${ano}-05-01`, tipo: 'feriado_nacional', descricao: 'Dia do Trabalhador' },
        { data: `${ano}-09-07`, tipo: 'feriado_nacional', descricao: 'Independência do Brasil' },
        { data: `${ano}-10-12`, tipo: 'feriado_nacional', descricao: 'Nossa Senhora Aparecida' },
        { data: `${ano}-11-02`, tipo: 'feriado_nacional', descricao: 'Finados' },
        { data: `${ano}-11-15`, tipo: 'feriado_nacional', descricao: 'Proclamação da República' },
        { data: `${ano}-12-25`, tipo: 'feriado_nacional', descricao: 'Natal' },
    ];
    for (const f of feriados) {
        await db.query(
            `INSERT IGNORE INTO calendario_escolar (data, tipo, descricao) VALUES (?, ?, ?)`,
            [f.data, f.tipo, f.descricao]
        );
    }
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor integrado rodando em http://localhost:${PORT}`);
    console.log(`📡 WebSocket ativo`);
    conectarRFID();
    conectarBiometrico();
    
    try {
        await iniciarWhatsApp();
        console.log('[WHATSAPP] Cliente iniciado. Aguardando QR Code...');
    } catch (err) {
        console.error('[WHATSAPP] Erro ao iniciar cliente:', err);
    }
    
    const anoAtual = new Date().getFullYear();
    await seedFeriados(anoAtual);
    console.log(`📅 Feriados nacionais de ${anoAtual} inseridos/verificados`);
    
    const [presentes] = await db.query(`
    SELECT a.id FROM presencas p 
    JOIN alunos a ON p.aluno_id = a.id 
    WHERE p.data = CURDATE() AND p.status = 'PRESENTE' AND p.saida IS NULL
`);

statusEscola.alunosPresentes.clear();
presentes.forEach(p => statusEscola.alunosPresentes.add(Number(p.id)));
console.log(`📌 Alunos presentes hoje: ${statusEscola.alunosPresentes.size}`);
    console.log(`📌 Status da Escola: ${statusEscola.estado}`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Encerrando servidor...');
    if (serialPortRFID?.isOpen) serialPortRFID.close();
    if (serialPortBIO?.isOpen) serialPortBIO.close();
    process.exit(0);
});
