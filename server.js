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

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

(async () => {
    try {
        const conn = await db.getConnection();
        console.log('✅ Conectado ao MySQL!');
        
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
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS admin_master (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL
            )
        `);
        console.log('✅ Tabela admin_master verificada/criada');
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS guarita (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL
            )
        `);
        console.log('✅ Tabela guarita verificada/criada');
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS presencas (
                id INT PRIMARY KEY AUTO_INCREMENT,
                aluno_id INT NOT NULL,
                tipo_sistema VARCHAR(10),
                data DATE,
                entrada TIME,
                saida TIME,
                status VARCHAR(20),
                FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Tabela presencas verificada/criada');
        
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
    horarioFechamento: '18:00'
};

let historicoAcessos = [];
const MAX_HISTORICO = 50;

let timeoutAtualizacao = null;

async function getAlunoByNome(nome) {
    const [rows] = await db.query('SELECT * FROM alunos WHERE name = ?', [nome]);
    return rows[0];
}
async function getAlunoByUID(uidHex) {
    // uidHex é string sem espaços, ex: "428B21F6"
    const [rows] = await db.query('SELECT * FROM alunos WHERE rfid_uid = ?', [uidHex]);
    return rows[0];
}

async function getAlunoById(id) {
    const [rows] = await db.query('SELECT id, name, matricula, ano, curso, tipo_acesso, rfid_uid, bio_id FROM alunos WHERE id = ?', [id]);
    return rows[0];
}

async function getAllAlunos() {
    const hoje = new Date().toISOString().slice(0, 10);
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
                WHERE data = ?
            ) ranked WHERE rn = 1
        ) p ON p.aluno_id = a.id
        ORDER BY a.name
    `, [hoje]);
    return rows;
}

async function registrarAcessoLog(alunoId, nome, matricula, aprovado, motivo, tipo) {
    const hora = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const dataISO = new Date().toISOString().slice(0, 10);
    await db.query(
        `INSERT INTO logs_acessos (aluno_id, nome_aluno, matricula, aprovado, motivo, tipo_sistema, hora, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [alunoId, nome, matricula, aprovado ? 1 : 0, motivo, tipo, hora, dataISO]
    );
}

async function broadcastStatus() {
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM alunos');
    const [[{ totalBio }]] = await db.query("SELECT COUNT(*) as totalBio FROM alunos WHERE tipo_acesso IN ('BIO','AMBOS') AND bio_id IS NOT NULL");
    const status = {
        rfidConectado: serialPortRFID && serialPortRFID.isOpen,
        biometricoConectado: serialPortBIO && serialPortBIO.isOpen,
        totalAlunos: total,
        totalDigitais: totalBio,
        ultimaAtualizacao: new Date().toLocaleString('pt-BR'),
        escola: {
            estado: statusEscola.estado,
            ultimaMudanca: statusEscola.ultimaMudanca,
            alunosPresentes: statusEscola.alunosPresentes.size,
            horarioEntrada: statusEscola.horarioEntrada,
            horarioSaida: statusEscola.horarioSaida,
            horarioFechamento: statusEscola.horarioFechamento
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
        console.log('[WS] Enviando ATUALIZAR_ALUNOS');
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

async function marcarPresenca(nome, tipo) {
    try {
        const aluno = await getAlunoByNome(nome);
        if (!aluno) {
            await registrarAcesso(nome, 'N/A', false, 'ALUNO_NAO_ENCONTRADO', tipo);
            enviarRespostaAcesso(tipo, 'NAO:ALUNO_NAO_ENCONTRADO');
            return;
        }
        
        const alunoId = Number(aluno.id);
        const hoje = new Date().toISOString().slice(0, 10);
        const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour12: false });
        
        const [presenca] = await db.query(
            'SELECT * FROM presencas WHERE aluno_id = ? AND data = ? ORDER BY id DESC LIMIT 1',
            [alunoId, hoje]
        );

        console.log(`[ACESSO] ${nome} (${tipo}) - Estado: ${statusEscola.estado}`);
        console.log(`[ACESSO] Presença encontrada: ${presenca.length > 0 ? 'SIM' : 'NÃO'}`);
        if (presenca.length > 0) {
            console.log(`[ACESSO] Status: ${presenca[0].status}, Entrada: ${presenca[0].entrada}, Saida: ${presenca[0].saida || 'NÃO'}`);
        }
        console.log(`[ACESSO] Set presentes: ${statusEscola.alunosPresentes.has(alunoId)}`);

        if (statusEscola.estado === 'ABERTA') {
            if (presenca.length === 0) {
                await db.query(`INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status) VALUES (?, ?, ?, ?, 'PRESENTE')`, [alunoId, tipo, hoje, horaAtual]);
                statusEscola.alunosPresentes.add(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'ENTRADA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:ENTRADA_PERMITIDA');
                broadcastAtualizacaoAlunos();
                console.log(`[ACESSO] ✅ ${nome} ENTROU às ${horaAtual}`);
            } else if (presenca[0].saida) {
                await db.query(`INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status) VALUES (?, ?, ?, ?, 'PRESENTE')`, [alunoId, tipo, hoje, horaAtual]);
                statusEscola.alunosPresentes.add(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'REENTRADA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:REENTRADA_PERMITIDA');
                broadcastAtualizacaoAlunos();
                console.log(`[ACESSO] ✅ ${nome} REENTROU às ${horaAtual}`);
            } else {
                await registrarAcesso(aluno.name, aluno.matricula, true, 'JA_PRESENTE', tipo);
                enviarRespostaAcesso(tipo, 'SIM:JA_PRESENTE');
                console.log(`[ACESSO] ℹ️ ${nome} já está presente`);
            }
        }
        else if (statusEscola.estado === 'SAIDA') {
            const estaPresente = statusEscola.alunosPresentes.has(alunoId) || (presenca.length > 0 && !presenca[0].saida);
            
            console.log(`[ACESSO] SAIDA - Aluno presente? ${estaPresente}`);
            
            if (estaPresente) {
                if (presenca.length > 0 && !presenca[0].saida) {
                    await db.query('UPDATE presencas SET saida = ?, status = "SAIU" WHERE id = ?', [horaAtual, presenca[0].id]);
                    console.log(`[ACESSO] SAIDA - Registro ${presenca[0].id} atualizado com saida ${horaAtual}`);
                } else if (presenca.length === 0) {
                    await db.query(`INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status) VALUES (?, ?, ?, ?, 'SAIU')`, [alunoId, tipo, hoje, horaAtual]);
                    console.log(`[ACESSO] SAIDA - Criado registro com saida ${horaAtual}`);
                }
                statusEscola.alunosPresentes.delete(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_PERMITIDA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:SAIDA_PERMITIDA');
                broadcastAtualizacaoAlunos();
                console.log(`[ACESSO] ✅ ${nome} SAIU às ${horaAtual}`);
            } else {
                await registrarAcesso(aluno.name, aluno.matricula, false, 'NAO_PRESENTE', tipo);
                enviarRespostaAcesso(tipo, 'NAO:NAO_PRESENTE');
                console.log(`[ACESSO] ❌ ${nome} tentou sair mas não estava presente`);
            }
        }
        else if (statusEscola.estado === 'FECHADA') {
            const estaPresente = statusEscola.alunosPresentes.has(alunoId) || (presenca.length > 0 && !presenca[0].saida);
            
            console.log(`[ACESSO] FECHADA - Aluno presente? ${estaPresente}`);
            
            if (estaPresente) {
                if (presenca.length > 0 && !presenca[0].saida) {
                    await db.query('UPDATE presencas SET saida = ?, status = "SAIU_EMERGENCIA" WHERE id = ?', [horaAtual, presenca[0].id]);
                    console.log(`[ACESSO] FECHADA - Registro ${presenca[0].id} atualizado com saida emergência ${horaAtual}`);
                } else if (presenca.length === 0) {
                    await db.query(`INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status) VALUES (?, ?, ?, ?, 'SAIU_EMERGENCIA')`, [alunoId, tipo, hoje, horaAtual]);
                    console.log(`[ACESSO] FECHADA - Criado registro com saida emergência ${horaAtual}`);
                }
                statusEscola.alunosPresentes.delete(alunoId);
                await registrarAcesso(aluno.name, aluno.matricula, true, 'SAIDA_EMERGENCIA', tipo);
                enviarRespostaAcesso(tipo, 'SIM:SAIDA_EMERGENCIA');
                broadcastAtualizacaoAlunos();
                console.log(`[ACESSO] 🚨 ${nome} SAIU EM EMERGÊNCIA às ${horaAtual}`);
            } else {
                await registrarAcesso(aluno.name, aluno.matricula, false, 'ESCOLA_FECHADA', tipo);
                enviarRespostaAcesso(tipo, 'NAO:ESCOLA_FECHADA');
                console.log(`[ACESSO] ❌ ${nome} tentou entrar mas escola está fechada`);
            }
        }
    } catch (err) {
        console.error('[ERRO] marcarPresenca:', err);
        enviarRespostaAcesso(tipo, 'NAO:ERRO_INTERNO');
    }
}

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
    console.log(`[RFID] UID recebido: ${uidHex}`);
    
    // Busca aluno pelo rfid_uid
    const [aluno] = await db.query('SELECT * FROM alunos WHERE rfid_uid = ?', [uidHex]);
    if (!aluno || aluno.length === 0) {
        console.log(`[RFID] UID não cadastrado: ${uidHex}`);
        serialPortRFID.write('RESPOSTA_ACESSO:NAO:UID_NAO_CADASTRADO\n');
        await registrarAcesso('Desconhecido', 'N/A', false, 'UID_NAO_CADASTRADO', 'RFID');
    } else {
        // Chama a função de marcar presença (ela já cuida de tudo e envia a resposta)
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
            if (msg.includes('bio:Identificado:')) {
                const partes = msg.split(':');
                if (partes.length >= 4) {
                    const nome = partes[3];
                    await marcarPresenca(nome, 'BIO');
                }
            }
            if (msg.includes('ACESSO_NEGADO:DIGITAL_NAO_CADASTRADA'))
                await registrarAcesso('Desconhecido', 'N/A', false, 'DIGITAL_NAO_CADASTRADA', 'BIO');
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
    res.json({ success: true, user: rows[0], role: req.usuario.role });
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
    try {
        await db.query(`UPDATE alunos SET name=?, matricula=?, ano=?, curso=?, responsavel_nome=?, responsavel_telefone=?, responsavel_email=?, foto=? WHERE id=?`, [name, matricula, ano, curso, responsavel_nome, responsavel_telefone, responsavel_email, foto, id]);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Dados atualizados com sucesso!' });
    } catch (err) {
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

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
        
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Aluno cadastrado com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor' });
    }
});

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
        
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Digital cadastrada com sucesso!' });
    } catch (err) {
        console.error('[ERRO] /api/cadastrar-digital:', err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

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
        
        let password_hash = null;
        if (senha_login && senha_login.length >= 6) {
            password_hash = await bcrypt.hash(senha_login, 10);
        }
        
        const [result] = await db.query(`
            INSERT INTO alunos (name, matricula, ano, curso, tipo_acesso, 
            responsavel_nome, responsavel_telefone, responsavel_email, email, password_hash, data_cadastro, foto) 
            VALUES (?, ?, ?, ?, 'AMBOS', ?, ?, ?, ?, ?, NOW(), ?)
        `, [nome, matricula, ano || 'N/A', curso || 'N/A', responsavel_nome || null, responsavel_telefone || null, responsavel_email || null, email_login, password_hash, foto || null]);
        
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

app.get('/api/escola/status', autenticar, (req, res) => res.json(statusEscola));

app.post('/api/escola/alterar-status', autenticar, (req, res) => {
    const { novoStatus } = req.body;
    if (!['ABERTA', 'SAIDA', 'FECHADA'].includes(novoStatus)) return res.status(400).json({ sucesso: false, mensagem: 'Status inválido' });
    statusEscola.estado = novoStatus;
    statusEscola.ultimaMudanca = new Date().toLocaleString('pt-BR');
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: `Escola alterada para ${novoStatus}` });
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

app.get('/api/escola/presentes', autenticar, async (req, res) => {
    const ids = Array.from(statusEscola.alunosPresentes);
    if (!ids.length) return res.json({ totalPresentes: 0, alunosPresentes: [] });
    const hoje = new Date().toISOString().slice(0, 10);
    const placeholders = ids.map(() => '?').join(',');
    const [alunos] = await db.query(`SELECT a.name, a.matricula, a.ano, a.curso, p.entrada FROM alunos a LEFT JOIN presencas p ON p.aluno_id = a.id AND p.data = ? WHERE a.id IN (${placeholders})`, [hoje, ...ids]);
    res.json({ totalPresentes: alunos.length, alunosPresentes: alunos });
});

app.get('/api/ultimo-acesso', autenticar, (req, res) => {
    const ultimo = historicoAcessos.length ? historicoAcessos[0] : null;
    res.json({ sucesso: true, acesso: ultimo });
});

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

app.get('/api/historico-acessos', autenticar, async (req, res) => {
    try {
        const { data, aprovado, limite } = req.query;
        let sql = 'SELECT * FROM logs_acessos WHERE 1=1';
        const params = [];
        if (data) { sql += ' AND data = ?'; params.push(data); }
        if (aprovado !== undefined) { sql += ' AND aprovado = ?'; params.push(parseInt(aprovado)); }
        const lim = Math.min(parseInt(limite) || 100, 500);
        sql += ' ORDER BY id DESC LIMIT ?';
        params.push(lim);
        const [rows] = await db.query(sql, params);
        res.json({ sucesso: true, acessos: rows });
    } catch (err) {
        console.error('[ERRO] /api/historico-acessos:', err.message);
        res.status(500).json({ sucesso: false, acessos: [] });
    }
});

app.get('/api/presencas', autenticar, async (req, res) => {
    try {
        const { data, nome, curso, turma, tipo_sistema } = req.query;
        let sql = `SELECT p.id, a.name AS nome_aluno, a.matricula, a.curso, a.ano, CONCAT(a.ano, '° ', a.curso) AS turma, p.data, p.entrada, p.saida, p.tipo_sistema, p.status FROM presencas p JOIN alunos a ON p.aluno_id = a.id WHERE 1=1`;
        const params = [];
        if (data) { sql += ' AND p.data = ?'; params.push(data); }
        if (nome) { sql += ' AND a.name LIKE ?'; params.push(`%${nome}%`); }
        if (curso && curso !== '') { sql += ' AND a.curso = ?'; params.push(curso); }
        if (turma && turma !== '') { sql += ' AND CONCAT(a.ano, "° ", a.curso) = ?'; params.push(turma); }
        if (tipo_sistema && tipo_sistema !== '') { sql += ' AND p.tipo_sistema = ?'; params.push(tipo_sistema); }
        sql += ' ORDER BY p.data DESC, p.entrada DESC LIMIT 500';
        const [rows] = await db.query(sql, params);
        res.json({ sucesso: true, presencas: rows });
    } catch (err) {
        console.error('[ERRO] /api/presencas:', err.message);
        res.status(500).json({ sucesso: false, presencas: [] });
    }
});

// ==================== ROTAS PARA O ALUNO (acesso-aluno.html) ====================
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
// ==================== ROTAS PARA O DASHBOARD DE GESTÃO ====================

app.get('/api/admin-gestao/stats', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        
        // Total de alunos
        const [totalAlunosResult] = await db.query('SELECT COUNT(*) as total FROM alunos');
        const totalAlunos = totalAlunosResult[0].total;
        
        // Presentes hoje
        const hoje = new Date().toISOString().slice(0, 10);
        const [presentesResult] = await db.query(
            'SELECT COUNT(DISTINCT aluno_id) as total FROM presencas WHERE data = ? AND status = "PRESENTE" AND saida IS NULL',
            [hoje]
        );
        const presentesHoje = presentesResult[0].total || 0;
        
        // Média de frequência (últimos 30 dias)
        const [mediaResult] = await db.query(`
            SELECT COUNT(DISTINCT data) as dias_com_presenca 
            FROM presencas 
            WHERE data >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `);
        const diasComPresenca = mediaResult[0].dias_com_presenca || 0;
        const mediaFrequencia = Math.round((diasComPresenca / 30) * 100);
        
        // Alunos ativos (que tiveram pelo menos uma presença nos últimos 30 dias)
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
        
        // Formatar os dados para o frontend
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

// Rota melhorada para presenças
app.get('/api/presencas', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false, message: 'Acesso negado' });
        }
        
        const { data, nome, curso, tipo_sistema, status, limite = 500 } = req.query;
        
        let sql = `
            SELECT 
                p.id,
                p.aluno_id,
                a.name AS nome_aluno,
                a.matricula,
                a.curso,
                a.ano,
                p.data,
                p.entrada,
                p.saida,
                p.tipo_sistema,
                p.status
            FROM presencas p
            INNER JOIN alunos a ON p.aluno_id = a.id
            WHERE 1=1
        `;
        
        const params = [];
        
        if (data) {
            sql += ' AND p.data = ?';
            params.push(data);
        }
        
        if (nome) {
            sql += ' AND a.name LIKE ?';
            params.push(`%${nome}%`);
        }
        
        if (curso && curso !== '') {
            sql += ' AND a.curso = ?';
            params.push(curso);
        }
        
        if (tipo_sistema && tipo_sistema !== '') {
            sql += ' AND p.tipo_sistema = ?';
            params.push(tipo_sistema);
        }
        
        if (status && status !== '') {
            sql += ' AND p.status = ?';
            params.push(status);
        }
        
        sql += ' ORDER BY p.data DESC, p.entrada DESC LIMIT ?';
        params.push(parseInt(limite) || 500);
        
        const [presencas] = await db.query(sql, params);
        
        // Formatar datas
        const presencasFormatadas = presencas.map(p => ({
            ...p,
            data_formatada: p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '-',
            entrada: p.entrada || '-',
            saida: p.saida || '-',
            nome_aluno: p.nome_aluno || 'N/A',
            matricula: p.matricula || 'N/A',
            curso: p.curso || 'N/A',
            tipo_sistema: p.tipo_sistema || '-',
            status: p.status || 'AUSENTE'
        }));
        
        res.json({
            success: true,
            presencas: presencasFormatadas,
            total: presencasFormatadas.length
        });
    } catch (error) {
        console.error('[ERRO] /api/presencas:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro ao carregar presenças',
            presencas: [] 
        });
    }
});

// Rota para buscar todos os alunos (para debug)
app.get('/api/todos-alunos', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false });
        }
        
        const [alunos] = await db.query(`
            SELECT id, name, matricula, curso, ano, tipo_acesso, data_cadastro 
            FROM alunos 
            ORDER BY name
        `);
        
        res.json({ success: true, alunos });
    } catch (error) {
        console.error('[ERRO] /api/todos-alunos:', error);
        res.status(500).json({ success: false, alunos: [] });
    }
});

// Rota para buscar presenças de um aluno específico
app.get('/api/aluno-presencas/:id', autenticar, async (req, res) => {
    try {
        if (req.usuario.role !== 'admin_gestao' && req.usuario.role !== 'admin_master') {
            return res.status(403).json({ success: false });
        }
        
        const alunoId = req.params.id;
        
        const [presencas] = await db.query(`
            SELECT 
                data,
                entrada,
                saida,
                tipo_sistema,
                status
            FROM presencas
            WHERE aluno_id = ?
            ORDER BY data DESC, entrada DESC
            LIMIT 100
        `, [alunoId]);
        
        res.json({ success: true, presencas });
    } catch (error) {
        console.error('[ERRO] /api/aluno-presencas:', error);
        res.status(500).json({ success: false, presencas: [] });
    }
});
app.get('/api/stats-publicos', async (req, res) => {
    try {
        const [[{ totalAlunos }]] = await db.query('SELECT COUNT(*) as totalAlunos FROM alunos');
        const [[{ totalAdminMaster }]] = await db.query('SELECT COUNT(*) as totalAdminMaster FROM admin_master');
        const [[{ totalGuarita }]] = await db.query('SELECT COUNT(*) as totalGuarita FROM guarita');
        let totalAdminGestao = 0;
        try { const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM admin_gestao'); totalAdminGestao = total; } catch(e) {}
        res.json({ success: true, alunos: totalAlunos, admin_master: totalAdminMaster, guarita: totalGuarita, admin_gestao: totalAdminGestao, total: totalAlunos + totalAdminMaster + totalGuarita + totalAdminGestao });
    } catch (err) {
        console.error('[ERRO] /api/stats-publicos:', err.message);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});
app.get('/dashboard-gestao.html', autenticar, (req, res) => {
    if (req.usuario.role !== 'admin_gestao') return res.status(403).send('Acesso negado');
    res.sendFile(path.join(__dirname, 'public', 'dashboard-gestao.html'));
});

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'arduino-menu.html')));
app.get('/admin', autenticar, (req, res) => {
    if (!['admin_master', 'admin_gestao'].includes(req.usuario.role)) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/acesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'acesso.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configuracoes.html')));
app.get('/historico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'historico.html')));
app.get('/dashboard-gestao.html', autenticar, (req, res) => {
    if (req.usuario.role !== 'admin_gestao') return res.status(403).send('Acesso negado');
    res.sendFile(path.join(__dirname, 'public', 'dashboard-gestao.html'));
});

wss.on('connection', (ws) => {
    console.log('[WS] Cliente conectado');
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    if (historicoAcessos.length) broadcastUltimoAcesso(historicoAcessos[0]);
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor integrado rodando em http://localhost:${PORT}`);
    console.log(`📡 WebSocket ativo`);
    conectarRFID();
    conectarBiometrico();
    
    const hoje = new Date().toISOString().slice(0, 10);
    const [presentes] = await db.query(`
        SELECT a.id FROM presencas p 
        JOIN alunos a ON p.aluno_id = a.id 
        WHERE p.data = ? AND p.status = 'PRESENTE' AND p.saida IS NULL
    `, [hoje]);
    
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