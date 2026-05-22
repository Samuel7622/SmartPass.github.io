require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const WebSocket = require('ws');
const http = require('http');

// ==================== CONFIGURAÇÕES INICIAIS ====================
const app = express();
const PORT = 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('.')); // serve arquivos estáticos (HTML, CSS, JS)

const JWT_SECRET = process.env.JWT_SECRET || 'meu-segredo-muito-seguro';

// ==================== CONEXÃO MySQL ====================
const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: 'smartpass_db',
    waitForConnections: true,
    connectionLimit: 10
});

db.getConnection((err, conn) => {
    if (err) {
        console.error('❌ Erro MySQL:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado ao MySQL!');
    conn.release();
});

// ==================== VARIÁVEIS GLOBAIS (sistemas seriais) ====================
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
    alunosPresentes: new Set(), // guarda matrículas
    horarioEntrada: '07:00',
    horarioSaida: '17:00',
    horarioFechamento: '18:00'
};

let historicoAcessos = [];
const MAX_HISTORICO = 50;

// ==================== FUNÇÕES AUXILIARES DO BANCO ====================
async function getAlunoByMatricula(matricula) {
    const [rows] = await db.promise().query('SELECT * FROM alunos WHERE matricula = ?', [matricula]);
    return rows[0];
}

async function getAlunoByNome(nome) {
    const [rows] = await db.promise().query('SELECT * FROM alunos WHERE name = ?', [nome]);
    return rows[0];
}

async function getAlunoById(id) {
    const [rows] = await db.promise().query('SELECT * FROM alunos WHERE id = ?', [id]);
    return rows[0];
}

async function getAllAlunos() {
    const [rows] = await db.promise().query('SELECT id, name, matricula, ano, curso, rfid_tag, digital_id, created_at FROM alunos ORDER BY name');
    return rows;
}

async function cadastrarAlunoSQL(dados) {
    const { name, matricula, ano, curso, rfid_tag = null, digital_id = null } = dados;
    const email = `${matricula}@escola.com`; // email padrão
    const [result] = await db.promise().query(
        `INSERT INTO alunos (name, email, password_hash, matricula, ano, curso, rfid_tag, digital_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, email, '', matricula, ano, curso, rfid_tag, digital_id]
    );
    return result.insertId;
}

async function atualizarRfidTag(alunoId, rfid_tag) {
    await db.promise().query('UPDATE alunos SET rfid_tag = ? WHERE id = ?', [rfid_tag, alunoId]);
}

async function atualizarDigitalId(alunoId, digital_id) {
    await db.promise().query('UPDATE alunos SET digital_id = ? WHERE id = ?', [digital_id, alunoId]);
}

async function removerAlunoSQL(alunoId) {
    await db.promise().query('DELETE FROM alunos WHERE id = ?', [alunoId]);
}

async function buscarAlunoPorRfidTag(tag) {
    const [rows] = await db.promise().query('SELECT * FROM alunos WHERE rfid_tag = ?', [tag]);
    return rows[0];
}

async function registrarAcessoLog(alunoId, nome, matricula, aprovado, motivo, tipo) {
    const now = new Date();
    const hora = now.toLocaleTimeString('pt-BR');
    const data = now.toLocaleDateString('pt-BR');
    await db.promise().query(
        `INSERT INTO logs_acessos (aluno_id, nome_aluno, matricula, aprovado, motivo, tipo_sistema, hora, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [alunoId, nome, matricula, aprovado, motivo, tipo, hora, data]
    );
}

// ==================== WEBSOCKET BROADCAST ====================
function broadcastStatus() {
    const status = {
        rfidConectado: serialPortRFID && serialPortRFID.isOpen,
        biometricoConectado: serialPortBIO && serialPortBIO.isOpen,
        totalAlunos: 0, // será preenchido depois
        totalDigitais: 0,
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

function broadcastAtualizacaoAlunos() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'ATUALIZAR_ALUNOS', timestamp: new Date().toLocaleString('pt-BR') }));
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

function broadcastStatusCadastro(mensagem, tipo, sistema) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ tipo: 'STATUS_CADASTRO', mensagem, sistema, timestamp: new Date().toLocaleString('pt-BR') }));
        }
    });
}

// ==================== FUNÇÕES DE NEGÓCIO (PRESENÇA E ACESSO) ====================
async function marcarPresenca(nome, tipo) {
    console.log(`[${tipo}] Marcando presença para: ${nome}`);
    const aluno = await getAlunoByNome(nome);
    if (!aluno) {
        const motivo = 'ALUNO_NAO_ENCONTRADO';
        await registrarAcessoLog(null, nome, 'N/A', false, motivo, tipo);
        if (tipo === 'RFID' && serialPortRFID?.isOpen)
            serialPortRFID.write('RESPOSTA_ACESSO:NAO:ALUNO_NAO_ENCONTRADO\n');
        return;
    }

    const hoje = new Date().toISOString().slice(0,10);
    const horaAtual = new Date().toTimeString().slice(0,8);
    const matricula = aluno.matricula;

    // Escola FECHADA
    if (statusEscola.estado === 'FECHADA') {
        const estaPresente = statusEscola.alunosPresentes.has(matricula);
        if (estaPresente) {
            // saída de emergência
            await db.promise().query(
                `INSERT INTO presencas (aluno_id, tipo_sistema, data, saida, status)
                 VALUES (?, ?, ?, ?, 'SAIU_EMERGENCIA')
                 ON DUPLICATE KEY UPDATE saida = VALUES(saida), status = 'SAIU_EMERGENCIA'`,
                [aluno.id, tipo, hoje, horaAtual]
            );
            statusEscola.alunosPresentes.delete(matricula);
            await registrarAcessoLog(aluno.id, aluno.name, matricula, true, 'SAIDA_EMERGENCIA', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:SIM:SAIDA_EMERGENCIA\n');
        } else {
            await registrarAcessoLog(aluno.id, aluno.name, matricula, false, 'ESCOLA_FECHADA', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:NAO:ESCOLA_FECHADA\n');
        }
        return;
    }

    // Escola ABERTA
    if (statusEscola.estado === 'ABERTA') {
        if (!statusEscola.alunosPresentes.has(matricula)) {
            // entrada
            await db.promise().query(
                `INSERT INTO presencas (aluno_id, tipo_sistema, data, entrada, status)
                 VALUES (?, ?, ?, ?, 'PRESENTE')
                 ON DUPLICATE KEY UPDATE entrada = VALUES(entrada), status = 'PRESENTE'`,
                [aluno.id, tipo, hoje, horaAtual]
            );
            statusEscola.alunosPresentes.add(matricula);
            await registrarAcessoLog(aluno.id, aluno.name, matricula, true, 'ENTRADA_PERMITIDA', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:SIM:ENTRADA_PERMITIDA\n');
        } else {
            // já presente – apenas log
            await registrarAcessoLog(aluno.id, aluno.name, matricula, true, 'JA_PRESENTE', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:SIM:JA_PRESENTE\n');
        }
        return;
    }

    // Escola em SAÍDA
    if (statusEscola.estado === 'SAIDA') {
        if (statusEscola.alunosPresentes.has(matricula)) {
            await db.promise().query(
                `UPDATE presencas SET saida = ?, status = 'SAIU'
                 WHERE aluno_id = ? AND data = ? AND tipo_sistema = ?`,
                [horaAtual, aluno.id, hoje, tipo]
            );
            statusEscola.alunosPresentes.delete(matricula);
            await registrarAcessoLog(aluno.id, aluno.name, matricula, true, 'SAIDA_PERMITIDA', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:SIM:SAIDA_PERMITIDA\n');
        } else {
            await registrarAcessoLog(aluno.id, aluno.name, matricula, false, 'NAO_PRESENTE', tipo);
            if (tipo === 'RFID') serialPortRFID?.write('RESPOSTA_ACESSO:NAO:NAO_PRESENTE\n');
        }
        return;
    }
}
// ==================== COMUNICAÇÃO SERIAL (RFID) ====================
function conectarRFID() {
    try {
        serialPortRFID = new SerialPort({ path: 'COM4', baudRate: 9600 });
        parserRFID = serialPortRFID.pipe(new ReadlineParser({ delimiter: '\n' })); // <-- LINHA FALTANDO

        serialPortRFID.on('open', () => {
            console.log('[RFID] ✅ Conectado na COM4');
            broadcastStatus();
        });

        serialPortRFID.on('error', (err) => {
            console.log('[RFID] ❌ Erro:', err.message);
            broadcastStatus();
        });

        parserRFID.on('data', async (data) => {
            const msg = data.toString().trim();
            console.log('[RFID]', msg);
            // ... todo o resto do seu código dentro do parser (já existe)
        });

        return true;
    } catch (err) {
        console.log('[RFID] ❌ Falha:', err.message);
        return false;
    }
}

// ==================== COMUNICAÇÃO SERIAL (BIOMÉTRICO) ====================
function conectarBiometrico() {
    try {
        // Se você não tem o biométrico ainda, pode comentar esta linha
        serialPortBIO = new SerialPort({ path: 'COM10', baudRate: 115200 });
        parserBIO = serialPortBIO.pipe(new ReadlineParser({ delimiter: '\n' })); // <-- LINHA FALTANDO

        serialPortBIO.on('open', () => {
            console.log('[BIO] ✅ Conectado na COM10');
            broadcastStatus();
        });

        serialPortBIO.on('error', (err) => {
            console.log('[BIO] ❌ Erro:', err.message);
            broadcastStatus();
        });

        parserBIO.on('data', async (data) => {
            const msg = data.toString().trim();
            console.log('[BIO]', msg);
            // ... todo o resto do código do biométrico
        });

        return true;
    } catch (err) {
        console.log('[BIO] ❌ Falha:', err.message);
        return false;
    }
}

function enviarComandoRFID(comando, timeoutCustom = null) {
    return new Promise((resolve) => {
        if (!serialPortRFID || !serialPortRFID.isOpen) {
            resolve({ sucesso: false, mensagem: 'RFID não conectado' });
            return;
        }
        let timeout = timeoutCustom || TIMEOUT_PADRAO;
        if (comando.startsWith('CADASTRAR:')) timeout = TIMEOUT_CADASTRO;

        console.log('[RFID] Enviando:', comando);
        serialPortRFID.write(comando + '\n');
        aguardandoRespostaRFID = true;
        callbackRespostaRFID = (sucesso, mensagem, tag = null) => {
            resolve({ sucesso, mensagem, tag });
        };
        setTimeout(() => {
            if (aguardandoRespostaRFID) {
                aguardandoRespostaRFID = false;
                callbackRespostaRFID = null;
                resolve({ sucesso: false, mensagem: 'Timeout - RFID não respondeu' });
            }
        }, timeout);
    });
}

// ==================== COMUNICAÇÃO SERIAL (BIOMÉTRICO) ====================
function conectarBiometrico() {
    try {
       serialPortBIO = new SerialPort({ path: 'COM10', baudRate: 115200 });

        serialPortBIO.on('open', () => {
            console.log('[BIO] ✅ Conectado na COM10');
            broadcastStatus();
        });
        serialPortBIO.on('error', (err) => {
            console.log('[BIO] ❌ Erro:', err.message);
            broadcastStatus();
        });

        parserBIO.on('data', async (data) => {
            const msg = data.toString().trim();
            console.log('[BIO]', msg);

            if (msg.includes('ACESSO_NEGADO:DIGITAL_NAO_CADASTRADA')) {
                await registrarAcessoLog(null, 'Desconhecido', 'N/A', false, 'DIGITAL_NAO_CADASTRADA', 'BIO');
            }
            if (msg.includes('>>> Coloque o dedo no sensor...')) {
                broadcastStatusCadastro('Coloque o dedo no sensor...', 'info', 'BIO');
            }
            if (msg.includes('>>> RETIRE o dedo...')) {
                broadcastStatusCadastro('RETIRE o dedo do sensor...', 'warning', 'BIO');
            }
            if (msg.includes('>>> Coloque o MESMO dedo novamente...')) {
                broadcastStatusCadastro('Coloque o MESMO dedo novamente...', 'info', 'BIO');
            }
            if (msg.includes('Criando modelo biométrico...')) broadcastStatusCadastro('Criando modelo...', 'info', 'BIO');
            if (msg.includes('Armazenando no sensor...')) broadcastStatusCadastro('Armazenando digital...', 'info', 'BIO');
            if (msg.includes('✓ Dedo detectado!')) broadcastStatusCadastro('✓ Dedo detectado!', 'success', 'BIO');
            if (msg.includes('✓ Digital armazenada no sensor')) broadcastStatusCadastro('✓ Digital armazenada!', 'success', 'BIO');

            // Identificação de digital
            if (msg.includes('bio:Identificado:')) {
                const partes = msg.split(':');
                if (partes.length >= 4) {
                    const nome = partes[3];
                    await marcarPresenca(nome, 'BIO');
                }
            }

            // Respostas para comandos
            if (aguardandoRespostaBIO && callbackRespostaBIO) {
                if (msg.includes('cadastrado com sucesso')) {
                    broadcastStatusCadastro('✅ Digital cadastrada!', 'success', 'BIO');
                    callbackRespostaBIO(true, msg);
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                } else if (msg.includes('ERRO:')) {
                    callbackRespostaBIO(false, msg);
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                } else if (msg.includes('Usuário removido:')) {
                    callbackRespostaBIO(true, 'Digital removida!');
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                } else if (msg.includes('Todos os usuários foram removidos')) {
                    callbackRespostaBIO(true, 'Todas as digitais removidas!');
                    aguardandoRespostaBIO = false;
                    callbackRespostaBIO = null;
                }
            }
        });
        return true;
    } catch (err) {
        console.log('[BIO] ❌ Falha:', err.message);
        return false;
    }
}

function enviarComandoBIO(comando, timeoutCustom = null) {
    return new Promise((resolve) => {
        if (!serialPortBIO || !serialPortBIO.isOpen) {
            resolve({ sucesso: false, mensagem: 'Biométrico não conectado' });
            return;
        }
        let timeout = timeoutCustom || TIMEOUT_PADRAO;
        if (comando.startsWith('bio:Cadastrar:')) timeout = TIMEOUT_CADASTRO;

        console.log('[BIO] Enviando:', comando);
        serialPortBIO.write(comando + '\n');
        aguardandoRespostaBIO = true;
        callbackRespostaBIO = (sucesso, mensagem) => {
            resolve({ sucesso, mensagem });
        };
        setTimeout(() => {
            if (aguardandoRespostaBIO) {
                aguardandoRespostaBIO = false;
                callbackRespostaBIO = null;
                resolve({ sucesso: false, mensagem: 'Timeout - Biométrico não respondeu' });
            }
        }, timeout);
    });
}

// ==================== ROTAS DE AUTENTICAÇÃO (JWT) ====================
const roleToTable = {
    'aluno': 'alunos',
    'admin_ifpi': 'admin_ifpi',
    'admin_master': 'admin_master',
    'guarita': 'guarita'
};

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const tables = [
        { nome: 'alunos', role: 'aluno' },
        { nome: 'admin_ifpi', role: 'admin_ifpi' },
        { nome: 'admin_master', role: 'admin_master' },
        { nome: 'guarita', role: 'guarita' }
    ];
    try {
        let userFound = null, roleFound = null;
        for (const t of tables) {
            const [rows] = await db.promise().query(`SELECT id, name, email, password_hash FROM ${t.nome} WHERE email = ?`, [email]);
            if (rows.length) { userFound = rows[0]; roleFound = t.role; break; }
        }
        if (!userFound) return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
        const valid = await bcrypt.compare(password, userFound.password_hash);
        if (!valid) return res.status(401).json({ success: false, error: 'Credenciais inválidas' });

        const token = jwt.sign({ id: userFound.id, role: roleFound }, JWT_SECRET, { expiresIn: '8h' });
        res.cookie('token', token, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 8 * 3600000 });
        res.json({ success: true, user: { id: userFound.id, name: userFound.name, email: userFound.email, role: roleFound } });
    } catch(err) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

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

app.get('/api/me', autenticar, async (req, res) => {
    const { id, role } = req.usuario;
    const tabela = roleToTable[role];
    const [rows] = await db.promise().query(`SELECT id, name, email FROM ${tabela} WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ success: false });
    res.json({ success: true, user: rows[0], role });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/perfil/:id/:role', async (req, res) => {
    const { id, role } = req.params;
    const table = roleToTable[role];
    if (!table) return res.status(400).json({ success: false, error: 'Role inválida' });
    try {
        const [rows] = await db.promise().query(`SELECT id, name, email FROM ${table} WHERE id = ?`, [id]);
        if (!rows.length) return res.status(404).json({ success: false });
        res.json({ success: true, user: rows[0] });
    } catch(err) { res.status(500).json({ success: false }); }
});

app.put('/api/perfil/:id/:role', async (req, res) => {
    const { id, role } = req.params;
    const { name, email } = req.body;
    const table = roleToTable[role];
    try {
        await db.promise().query(`UPDATE ${table} SET name = ?, email = ? WHERE id = ?`, [name, email, id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false }); }
});

app.post('/api/alterar-senha', async (req, res) => {
    const { id, role, currentPassword, newPassword } = req.body;
    const table = roleToTable[role];
    try {
        const [rows] = await db.promise().query(`SELECT password_hash FROM ${table} WHERE id = ?`, [id]);
        if (!rows.length) return res.status(404).json({ success: false });
        const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!valid) return res.status(401).json({ success: false, error: 'Senha atual incorreta' });
        const newHash = await bcrypt.hash(newPassword, 10);
        await db.promise().query(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [newHash, id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false }); }
});

// ==================== ROTAS DE CONTROLE DE ACESSO (RFID + BIO) ====================
app.get('/api/alunos', async (req, res) => {
    const alunos = await getAllAlunos();
    res.json(alunos);
});

app.post('/api/cadastrar', async (req, res) => {
    try {
        const { nome, matricula, ano, curso } = req.body;
        const existe = await getAlunoByMatricula(matricula);
        if (existe) return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });

        // Insere sem RFID tag
        const alunoId = await cadastrarAlunoSQL({ name: nome, matricula, ano, curso });
        const resultadoArduino = await enviarComandoRFID(`CADASTRAR:${nome}`);
        if (resultadoArduino.sucesso) {
            const tag = resultadoArduino.tag || `TAG_${Date.now()}`;
            await atualizarRfidTag(alunoId, tag);
            broadcastAtualizacaoAlunos();
            res.json({ sucesso: true, mensagem: 'Aluno cadastrado com sucesso!' });
        } else {
            await removerAlunoSQL(alunoId);
            res.status(400).json({ sucesso: false, mensagem: resultadoArduino.mensagem });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/cadastrar-digital', async (req, res) => {
    try {
        const { nome, matricula, ano, curso } = req.body;
        const existe = await getAlunoByMatricula(matricula);
        if (existe) return res.status(400).json({ sucesso: false, mensagem: 'Matrícula já cadastrada!' });

        const alunoId = await cadastrarAlunoSQL({ name: nome, matricula, ano, curso });
        const resultadoArduino = await enviarComandoBIO(`bio:Cadastrar:${nome}`);
        if (resultadoArduino.sucesso) {
            // O sensor retorna um ID? Vamos usar o próprio ID do aluno como digital_id
            await atualizarDigitalId(alunoId, alunoId);
            broadcastAtualizacaoAlunos();
            res.json({ sucesso: true, mensagem: 'Digital cadastrada com sucesso!' });
        } else {
            await removerAlunoSQL(alunoId);
            res.status(400).json({ sucesso: false, mensagem: resultadoArduino.mensagem });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/remover-aluno', async (req, res) => {
    try {
        const { matricula } = req.body;
        const aluno = await getAlunoByMatricula(matricula);
        if (!aluno) return res.status(404).json({ sucesso: false, mensagem: 'Aluno não encontrado' });
        if (aluno.rfid_tag) {
            await enviarComandoRFID(`REMOVER:${aluno.name}`);
        }
        await removerAlunoSQL(aluno.id);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Aluno removido!' });
    } catch (err) {
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/remover-digital', async (req, res) => {
    try {
        const { matricula } = req.body;
        const aluno = await getAlunoByMatricula(matricula);
        if (!aluno || !aluno.digital_id) return res.status(404).json({ sucesso: false, mensagem: 'Digital não encontrada' });
        await enviarComandoBIO(`bio:Deletar:${aluno.digital_id}`);
        await atualizarDigitalId(aluno.id, null);
        broadcastAtualizacaoAlunos();
        res.json({ sucesso: true, mensagem: 'Digital removida!' });
    } catch (err) {
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
    }
});

app.post('/api/limpar', async (req, res) => {
    await enviarComandoRFID('LIMPAR:TODOS');
    await db.promise().query('DELETE FROM alunos WHERE rfid_tag IS NOT NULL');
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: 'Alunos RFID removidos!' });
});

app.post('/api/limpar-digitais', async (req, res) => {
    await enviarComandoBIO('bio:Limpar');
    await db.promise().query('UPDATE alunos SET digital_id = NULL WHERE digital_id IS NOT NULL');
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: 'Digitais removidas!' });
});

app.post('/api/limpar-tudo', async (req, res) => {
    await enviarComandoRFID('LIMPAR:TODOS');
    await enviarComandoBIO('bio:Limpar');
    await db.promise().query('DELETE FROM alunos');
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: 'Tudo removido!' });
});

app.get('/api/status', async (req, res) => {
    const totalAlunos = (await getAllAlunos()).length;
    const totalDigitais = (await db.promise().query('SELECT COUNT(*) as total FROM alunos WHERE digital_id IS NOT NULL'))[0][0].total;
    res.json({
        rfidConectado: serialPortRFID && serialPortRFID.isOpen,
        biometricoConectado: serialPortBIO && serialPortBIO.isOpen,
        totalAlunos,
        totalDigitais,
        ultimaAtualizacao: new Date().toLocaleString('pt-BR'),
        escola: {
            estado: statusEscola.estado,
            ultimaMudanca: statusEscola.ultimaMudanca,
            alunosPresentes: statusEscola.alunosPresentes.size,
            horarioEntrada: statusEscola.horarioEntrada,
            horarioSaida: statusEscola.horarioSaida,
            horarioFechamento: statusEscola.horarioFechamento
        }
    });
});

app.get('/api/escola/status', (req, res) => {
    res.json(statusEscola);
});

app.post('/api/escola/alterar-status', (req, res) => {
    const { novoStatus } = req.body;
    if (!['ABERTA', 'SAIDA', 'FECHADA'].includes(novoStatus))
        return res.status(400).json({ sucesso: false, mensagem: 'Status inválido' });
    statusEscola.estado = novoStatus;
    statusEscola.ultimaMudanca = new Date().toLocaleString('pt-BR');
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: `Escola alterada para ${novoStatus}` });
});

app.post('/api/escola/simular-horario', (req, res) => {
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
    broadcastStatus();
    broadcastAtualizacaoAlunos();
    res.json({ sucesso: true, mensagem: `Simulação: escola ${novoStatus}` });
});

app.get('/api/escola/presentes', (req, res) => {
    const presentesArray = Array.from(statusEscola.alunosPresentes).map(matricula => ({ matricula }));
    res.json({ totalPresentes: statusEscola.alunosPresentes.size, alunosPresentes: presentesArray });
});

app.get('/api/ultimo-acesso', (req, res) => {
    const ultimo = historicoAcessos[0] || null;
    res.json({ sucesso: true, acesso: ultimo });
});

app.get('/api/historico-acessos', async (req, res) => {
    const [rows] = await db.promise().query('SELECT * FROM logs_acessos ORDER BY timestamp DESC LIMIT 100');
    res.json({ sucesso: true, acessos: rows });
});

// ==================== SERVE PÁGINAS ESTÁTICAS ====================
app.get('/', (req, res) => res.sendFile('arduino-menu.html', { root: '.' }));
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: '.' }));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html', { root: '.' }));
app.get('/login', (req, res) => res.sendFile('login.html', { root: '.' }));
app.get('/acesso', (req, res) => res.sendFile('acesso.html', { root: '.' }));

// ==================== INICIALIZAÇÃO DO SERVIDOR ====================
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
    conectarRFID();
    conectarBiometrico();
    // carrega alunos presentes do dia? (opcional)
    const hoje = new Date().toISOString().slice(0,10);
    const [presentes] = await db.promise().query(
        `SELECT a.matricula FROM presencas p JOIN alunos a ON p.aluno_id = a.id WHERE p.data = ? AND p.status = 'PRESENTE'`,
        [hoje]
    );
    presentes.forEach(p => statusEscola.alunosPresentes.add(p.matricula));
    console.log(`📌 Alunos presentes hoje: ${statusEscola.alunosPresentes.size}`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Encerrando servidor...');
    if (serialPortRFID && serialPortRFID.isOpen) serialPortRFID.close();
    if (serialPortBIO && serialPortBIO.isOpen) serialPortBIO.close();
    process.exit(0);
});