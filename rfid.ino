//Biblioteca do protocolo SPI 
#include <SPI.h>
//Biblioteca do RFID
#include <MFRC522.h>
//Importação para LCD + I2C
#include <Wire.h>  
#include <LiquidCrystal_I2C.h>
//Para usar EEPROM (memória permanente)
#include <EEPROM.h>

//Pinos de definição - Corrigido para suas conexões
#define SS_PIN 15   // D8 (SDA/SS)
#define RST_PIN 16  // D0 (RST)
#define MAX_USUARIOS 20  // Máximo de usuários cadastrados
#define TAMANHO_UID 4    // Tamanho do UID em bytes
#define TAMANHO_NOME 40  // Tamanho máximo do nome

//Cria a instancia do RFID (mfrc522)
MFRC522 mfrc522(SS_PIN, RST_PIN);   

//Estrutura para armazenar dados do usuário
struct Usuario {
  byte uid[TAMANHO_UID];
  char nome[TAMANHO_NOME];
  bool ativo;
};

Usuario usuarios[MAX_USUARIOS];
int totalUsuarios = 0;

//Objeto do LCD + I2C
LiquidCrystal_I2C lcd(0x27, 16, 2); 

//Pinos do LED RGB
int ledVermelho = 5;
int ledVerde = 2;
//definir o buzzer
const int BUZZER_PIN = 4;

//Variáveis para modo cadastro
bool modoCadastro = false;
String nomeParaCadastro = "";

// Sistema de consulta ao servidor
bool aguardandoRespostaServidor = false;
String nomeConsulta = "";
unsigned long tempoInicioConsulta = 0;
const unsigned long TIMEOUT_CONSULTA = 5000; // 5 segundos

// ✅ DEBOUNCE RÁPIDO (200ms) para leitura rápida de múltiplos cartões
unsigned long lastScanTime = 0;
const unsigned long DEBOUNCE_TIME = 200; // 200ms - DEBOUNCE RÁPIDO
byte lastUID[TAMANHO_UID] = {0, 0, 0, 0};

// ✅ NOVO: Sistema de estados e saúde da comunicação
unsigned long ultimaVerificacaoSaude = 0;
const unsigned long INTERVALO_VERIFICACAO_SAUDE = 1000; // Verifica saúde a cada 1s

void setup() {
  Serial.begin(9600);
  lcd.begin(16,2);
  SPI.begin();  
  mfrc522.PCD_Init();  
  
  pinMode(ledVermelho, OUTPUT);
  pinMode(ledVerde, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  // Carrega usuários da EEPROM
  carregarUsuarios();
  
  mensagemInicial();
  mostrarMenu();
}

void loop() {
  // Verifica comandos do Serial
  if (Serial.available()) {
    processarComando();
  }
  
  // ✅ VERIFICA SAÚDE DA COMUNICAÇÃO (NÃO-BLOQUEANTE)
  verificarSaudeComunicacao();
  
  // Verifica se há cartão próximo
  if (!mfrc522.PICC_IsNewCardPresent()) {
    return;
  }
  
  if (!mfrc522.PICC_ReadCardSerial()) {
    return;
  }
  
  // Lê o UID do cartão
  byte uidLido[TAMANHO_UID];
  for (byte i = 0; i < TAMANHO_UID; i++) {
    uidLido[i] = mfrc522.uid.uidByte[i];
  }
  
  // ✅ DEBOUNCE RÁPIDO (200ms) - MELHORADO
  unsigned long currentMillis = millis();
  bool uidChanged = false;
  for (int i = 0; i < TAMANHO_UID; i++) {
    if (uidLido[i] != lastUID[i]) {
      uidChanged = true;
      break;
    }
  }

  // ✅ BLOQUEIA LEITURAS REPETIDAS DO MESMO CARTÃO EM 200ms (RÁPIDO)
  if (!uidChanged && (currentMillis - lastScanTime < DEBOUNCE_TIME)) {
    Serial.println("[RFID] Leitura bloqueada - Debounce ativo");
    mfrc522.PICC_HaltA(); // Para o cartão
    return;
  }

  // Atualiza o último UID e o tempo de scan
  for (int i = 0; i < TAMANHO_UID; i++) {
    lastUID[i] = uidLido[i];
  }
  lastScanTime = currentMillis;
  
  // Mostra UID na serial
  Serial.print("UID lido: ");
  mostrarUID(uidLido);
  Serial.println();
  
  if (modoCadastro) {
    cadastrarNovoUsuario(uidLido, nomeParaCadastro);
  } else {
    verificarAcesso(uidLido);
  }
  
  mfrc522.PICC_HaltA(); // Para o cartão
}

// ✅ NOVA FUNÇÃO: Verifica saúde da comunicação
void verificarSaudeComunicacao() {
  unsigned long currentMillis = millis();
  
  // Verifica a cada 1 segundo (não-bloqueante)
  if (currentMillis - ultimaVerificacaoSaude >= INTERVALO_VERIFICACAO_SAUDE) {
    ultimaVerificacaoSaude = currentMillis;
    
    // Se está esperando resposta há mais tempo que o timeout, reseta
    if (aguardandoRespostaServidor) {
      if (currentMillis - tempoInicioConsulta > TIMEOUT_CONSULTA) {
        Serial.println("ERRO: Timeout - Resetando comunicação");
        processarAcessoNegado(nomeConsulta, "TIMEOUT_SERVIDOR");
        resetarComunicacao();
      }
    }
  }
}

// ✅ NOVA FUNÇÃO: Reseta comunicação quando trava
void resetarComunicacao() {
  Serial.println("RESET: Reiniciando comunicação com servidor...");
  
  // Limpa qualquer dado pendente na serial
  while(Serial.available()) {
    Serial.read();
  }
  
  // Reseta estados de comunicação
  aguardandoRespostaServidor = false;
  nomeConsulta = "";
  
  // Pequena pausa para estabilização
  delay(50);
  
  Serial.println("RESET: Comunicação reiniciada - Pronto para novos comandos");
}

void mostrarMenu() {
  Serial.println("\n=== MENU DE COMANDOS ===");
  Serial.println("CADASTRAR:<nome> - Cadastra novo usuário");
  Serial.println("LISTAR - Mostra todos os usuários");
  Serial.println("REMOVER:<nome> - Remove usuário por nome");
  Serial.println("LIMPAR:<UID> - Remove usuário específico");
  Serial.println("LIMPAR:TODOS - Remove todos os usuários");
  Serial.println("MENU - Mostra este menu");
  Serial.println("========================\n");
}

void processarComando() {
  String comando = Serial.readStringUntil('\n');
  comando.trim();
  
  // ✅ VERIFICA SE É RESPOSTA DO SERVIDOR (case sensitive)
  if (comando.startsWith("RESPOSTA_ACESSO:")) {
    if (aguardandoRespostaServidor) {
      Serial.println("DEBUG: Processando resposta do servidor");
      processarRespostaServidor(comando);
      aguardandoRespostaServidor = false;
      nomeConsulta = ""; // Limpa após processar
    } else {
      Serial.println("DEBUG: Resposta recebida mas não estava esperando");
    }
    return;
  }
  
  // Converte para maiúsculo para comandos normais
  comando.toUpperCase();
  
  if (comando.startsWith("CADASTRAR:")) {
    String nome = comando.substring(10);
    nome.trim();
    if (nome.length() > 0 && nome.length() <= TAMANHO_NOME-1) {
      iniciarCadastro(nome);
    } else {
      Serial.println("ERRO: Nome inválido! Use: CADASTRAR:NomeDoAluno");
    }
  }
  else if (comando == "LISTAR") {
    listarUsuarios();
  }
  else if (comando.startsWith("REMOVER:")) {
    String nome = comando.substring(8);
    removerUsuarioPorNome(nome);
  }
  else if (comando.startsWith("LIMPAR:")) {
    String parametro = comando.substring(7);
    if (parametro == "TODOS") {
      limparTodosUsuarios();
    } else {
      limparUsuarioPorUID(parametro);
    }
  }
  else if (comando == "MENU") {
    mostrarMenu();
  }
  else {
    Serial.println("ERRO: Comando não reconhecido. Digite MENU para ver os comandos.");
  }
}

void iniciarCadastro(String nome) {
  // ✅ VERIFICA SE NÃO ESTÁ AGUARDANDO RESPOSTA
  if (aguardandoRespostaServidor) {
    Serial.println("ERRO: Sistema ocupado aguardando resposta do servidor");
    return;
  }
  
  modoCadastro = true;
  nomeParaCadastro = nome;
  
  Serial.println("Modo cadastro ativado!");
  Serial.println("Aproxime a tag que deseja cadastrar para: " + nome);
  
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("MODO CADASTRO");
  lcd.setCursor(0, 1);
  lcd.print("Aproxime a tag");
  
  tone(BUZZER_PIN, 500, 500);
  delay(500);
  noTone(BUZZER_PIN);
}

void cadastrarNovoUsuario(byte uid[], String nome) {
  // Verifica se já existe
  int indiceExistente = buscarUsuario(uid);
  if (indiceExistente >= 0) {
    Serial.println("ERRO: Tag já está cadastrada");
    modoCadastro = false;
    mensagemInicial();
    return;
  }
  
  // Verifica se há espaço
  if (totalUsuarios >= MAX_USUARIOS) {
    Serial.println("ERRO: Limite de usuários atingido");
    modoCadastro = false;
    mensagemInicial();
    return;
  }
  
  // Cadastra o usuário
  for (int i = 0; i < TAMANHO_UID; i++) {
    usuarios[totalUsuarios].uid[i] = uid[i];
  }
  nome.toCharArray(usuarios[totalUsuarios].nome, TAMANHO_NOME);
  usuarios[totalUsuarios].ativo = true;
  
  totalUsuarios++;
  salvarUsuarios();
  
  // ✅ ENVIA RESPOSTA IMEDIATAMENTE PARA O SERVIDOR
  Serial.println("SUCESSO: Cadastrado com sucesso");
  Serial.println("Nome: " + nome);
  Serial.print("UID: ");
  mostrarUID(uid);
  Serial.println();
  
  tone(BUZZER_PIN, 1000, 150);
  delay(200);
  tone(BUZZER_PIN, 1500, 200);
  delay(250);
  noTone(BUZZER_PIN);
  
  lcd.clear();
  lcd.setCursor(0,0);
  lcd.print("CADASTRADO!");
  lcd.setCursor(0,1);
  lcd.print(nome.substring(0,16));
  
  digitalWrite(ledVerde, HIGH);
  delay(2000);
  digitalWrite(ledVerde, LOW);
  
  modoCadastro = false;
  mensagemInicial();
}

void verificarAcesso(byte uid[]) {
  // ✅ VERIFICA SE JÁ ESTÁ AGUARDANDO RESPOSTA
  if (aguardandoRespostaServidor) {
    Serial.println("AVISO: Sistema ocupado - Aguarde resposta anterior");
    return;
  }
  
  int indice = buscarUsuario(uid);
  
  lcd.clear();
  lcd.setCursor(0,0);
  
  if (indice >= 0) {
    String nome = String(usuarios[indice].nome);
    Serial.println("UID reconhecido: " + nome);
    
    lcd.print("Verificando...");
    lcd.setCursor(0,1);
    lcd.print(nome.substring(0,16));
    
    // ✅ ENVIA APENAS CONSULTA AO SERVIDOR
    consultarServidorAcesso(nome);
    
    aguardandoRespostaServidor = true;
    nomeConsulta = nome;
    tempoInicioConsulta = millis();
    
  } else {
    // Tag não cadastrada
    Serial.println("ERRO: Tag não cadastrada!");
    Serial.println("ACESSO_NEGADO:TAG_NAO_CADASTRADA");
    
    lcd.print("Tag nao cadastr!");
    lcd.setCursor(0,1);
    lcd.print("Acesso Negado!");
    
    tagInvalida();
    delay(1500);
    digitalWrite(ledVermelho, LOW);
    digitalWrite(ledVerde, LOW);
    mensagemInicial();
  }
}

int buscarUsuario(byte uid[]) {
  for (int i = 0; i < totalUsuarios; i++) {
    if (usuarios[i].ativo) {
      bool encontrado = true;
      for (int j = 0; j < TAMANHO_UID; j++) {
        if (usuarios[i].uid[j] != uid[j]) {
          encontrado = false;
          break;
        }
      }
      if (encontrado) {
        return i;
      }
    }
  }
  return -1;
}

void removerUsuarioPorNome(String nome) {
  bool encontrado = false;
  int usuariosRemovidos = 0;
  
  for (int i = 0; i < totalUsuarios; i++) {
    if (usuarios[i].ativo) {
      String nomeUsuario = String(usuarios[i].nome);
      nomeUsuario.toUpperCase();
      nome.toUpperCase();
      
      if (nomeUsuario == nome) {
        usuarios[i].ativo = false;
        encontrado = true;
        usuariosRemovidos++;
      }
    }
  }
  
  if (encontrado) {
    int novoIndice = 0;
    for (int i = 0; i < totalUsuarios; i++) {
      if (usuarios[i].ativo) {
        if (i != novoIndice) {
          usuarios[novoIndice] = usuarios[i];
        }
        novoIndice++;
      }
    }
    totalUsuarios = novoIndice;
    
    salvarUsuarios();
    Serial.println("SUCESSO: Usuário removido: " + nome);
  } else {
    Serial.println("ERRO: Usuário não encontrado: " + nome);
  }
}

void listarUsuarios() {
  Serial.println("\n=== USUÁRIOS CADASTRADOS ===");
  if (totalUsuarios == 0) {
    Serial.println("Nenhum usuário cadastrado.");
  } else {
    for (int i = 0; i < totalUsuarios; i++) {
      if (usuarios[i].ativo) {
        Serial.print("Nome: " + String(usuarios[i].nome));
        Serial.print(" | UID: ");
        mostrarUID(usuarios[i].uid);
        Serial.println();
      }
    }
  }
  Serial.println("==============================\n");
}

void limparUsuarioPorUID(String uidString) {
  byte uidProcurado[TAMANHO_UID];
  
  for (int i = 0; i < TAMANHO_UID; i++) {
    int pos = i * 3;
    if (pos + 1 < uidString.length()) {
      String hex = uidString.substring(pos, pos + 2);
      uidProcurado[i] = (byte)strtol(hex.c_str(), NULL, 16);
    }
  }
  
  int indice = buscarUsuario(uidProcurado);
  if (indice >= 0) {
    String nomeRemovido = String(usuarios[indice].nome);
    usuarios[indice].ativo = false;
    
    // Reorganiza o array
    int novoIndice = 0;
    for (int i = 0; i < totalUsuarios; i++) {
      if (usuarios[i].ativo) {
        if (i != novoIndice) {
          usuarios[novoIndice] = usuarios[i];
        }
        novoIndice++;
      }
    }
    totalUsuarios = novoIndice;
    
    salvarUsuarios();
    Serial.println("SUCESSO: Usuário removido: " + nomeRemovido);
  } else {
    Serial.println("ERRO: UID não encontrado.");
  }
}

void limparTodosUsuarios() {
  for (int i = 0; i < totalUsuarios; i++) {
    usuarios[i].ativo = false;
  }
  totalUsuarios = 0;
  salvarUsuarios();
  Serial.println("SUCESSO: Todos os usuários foram removidos");
}

void salvarUsuarios() {
  EEPROM.begin(512);
  int enderecoAtual = 0;
  
  EEPROM.write(enderecoAtual, totalUsuarios);
  enderecoAtual++;
  
  for (int i = 0; i < totalUsuarios; i++) {
    EEPROM.put(enderecoAtual, usuarios[i]);
    enderecoAtual += sizeof(Usuario);
  }
  
  EEPROM.commit();
  EEPROM.end();
}

void carregarUsuarios() {
  EEPROM.begin(512);
  int enderecoAtual = 0;
  
  totalUsuarios = EEPROM.read(enderecoAtual);
  enderecoAtual++;
  
  if (totalUsuarios < 0 || totalUsuarios > MAX_USUARIOS) {
    totalUsuarios = 0;
    EEPROM.end();
    return;
  }
  
  for (int i = 0; i < totalUsuarios; i++) {
    EEPROM.get(enderecoAtual, usuarios[i]);
    enderecoAtual += sizeof(Usuario);
  }
  
  EEPROM.end();
  Serial.println("INFO: Carregados " + String(totalUsuarios) + " usuários da memória.");
}

void mostrarUID(byte uid[]) {
  for (int i = 0; i < TAMANHO_UID; i++) {
    Serial.print(uid[i] < 0x10 ? "0" : "");
    Serial.print(uid[i], HEX);
    if (i < TAMANHO_UID - 1) Serial.print(" ");
  }
}

void mensagemInicial() {
  Serial.println("\nSISTEMA: Aproxime o cartao do leitor");
  
  lcd.clear();
  lcd.setCursor(0,0);
  lcd.print("Escola XYZ");
  lcd.setCursor(0,1);
  lcd.print("Aproxime a tag");
}

void tagValida() {
  digitalWrite(ledVermelho, LOW);
  digitalWrite(ledVerde, HIGH);
  
  tone(BUZZER_PIN, 1000, 150);
  delay(200);
  tone(BUZZER_PIN, 1500, 200);
  delay(250);
  noTone(BUZZER_PIN);
}

void tagInvalida() {
  digitalWrite(ledVermelho, HIGH);
  digitalWrite(ledVerde, LOW);
  
  tone(BUZZER_PIN, 400, 200);
  delay(200);
  tone(BUZZER_PIN, 600, 300);
  delay(150);
  noTone(BUZZER_PIN);
}

// ========== FUNÇÕES DO SISTEMA DE CONSULTA AO SERVIDOR ==========

void consultarServidorAcesso(String nome) {
  // ✅ ENVIA APENAS A CONSULTA - NÃO ENVIA "Olá"
  Serial.println("CONSULTAR_ACESSO:" + nome);
}

void processarRespostaServidor(String resposta) {
  // Formato: RESPOSTA_ACESSO:SIM:ENTRADA_PERMITIDA ou RESPOSTA_ACESSO:NAO:ESCOLA_FECHADA
  
  if (resposta.indexOf("SIM") > 0) {
    String statusAcesso = "";
    int pos = resposta.lastIndexOf(':');
    if (pos > 0) {
      statusAcesso = resposta.substring(pos + 1);
    }
    processarAcessoLiberado(nomeConsulta, statusAcesso);
  } else if (resposta.indexOf("NAO") > 0) {
    String motivo = "";
    int pos = resposta.lastIndexOf(':');
    if (pos > 0) {
      motivo = resposta.substring(pos + 1);
    }
    processarAcessoNegado(nomeConsulta, motivo);
  }
}

void processarAcessoLiberado(String nome, String statusAcesso) {
  // ✅ FEEDBACK LOCAL NO ARDUINO (NÃO ENVIA PARA O SERVIDOR)
  Serial.println("SUCESSO: Acesso Liberado!");
  Serial.println("INFO: Status Acesso: " + statusAcesso);
  
  lcd.clear();
  lcd.setCursor(0,0);
  lcd.print("Ola " + nome.substring(0,11) + "!");
  lcd.setCursor(0,1);
  
  if (statusAcesso == "ENTRADA_PERMITIDA") {
    lcd.print("Bem-vindo!");
  } else if (statusAcesso == "SAIDA_PERMITIDA") {
    lcd.print("Ate logo!");
  } else if (statusAcesso == "SAIDA_EMERGENCIA") {
    lcd.print("Saida segura!");
  } else if (statusAcesso == "JA_PRESENTE") {
    lcd.print("Ja esta presente");
  } else {
    lcd.print("Acesso OK!");
  }
  
  tagValida();
  delay(1500);
  
  digitalWrite(ledVermelho, LOW);
  digitalWrite(ledVerde, LOW);
  
  // ✅ LIMPA ESTADO APÓS PROCESSAR
  aguardandoRespostaServidor = false;
  nomeConsulta = "";
  
  mensagemInicial();
}

void processarAcessoNegado(String nome, String motivo) {
  Serial.println("ERRO: Acesso Negado!");
  Serial.println("INFO: Motivo: " + motivo);
  
  lcd.clear();
  lcd.setCursor(0,0);
  
  if (motivo == "ESCOLA_FECHADA") {
    lcd.print("Escola Fechada!");
    lcd.setCursor(0,1);
    lcd.print("Volte amanha");
  } else if (motivo == "ALUNO_NAO_ENCONTRADO") {
    lcd.print("Aluno nao");
    lcd.setCursor(0,1);
    lcd.print("encontrado!");
  } else if (motivo == "NAO_PRESENTE") {
    lcd.print("Nao esta");
    lcd.setCursor(0,1);
    lcd.print("presente!");
  } else if (motivo == "TIMEOUT_SERVIDOR") {
    lcd.print("Erro Servidor!");
    lcd.setCursor(0,1);
    lcd.print("Tente novamente");
  } else {
    lcd.print("Acesso Negado!");
    lcd.setCursor(0,1);
    lcd.print("Procure admin");
  }
  
  tagInvalida();
  delay(2000);
  
  digitalWrite(ledVermelho, LOW);
  digitalWrite(ledVerde, LOW);
  
  // ✅ LIMPA ESTADO APÓS PROCESSAR
  aguardandoRespostaServidor = false;
  nomeConsulta = "";
  
  mensagemInicial();
}