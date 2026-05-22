#include <SoftwareSerial.h>
#include <EEPROM.h>

// ========== CONFIGURAÇÃO DOS PINOS ==========
#define RX_PIN 14     // GPIO14 (D5)
#define TX_PIN 12     // GPIO12 (D6) 
#define POWER_PIN 13  // GPIO13 (D7) - SEMPRE HIGH!
#define LED_VERDE 4   // D2 - GPIO4
#define LED_VERMELHO 5 // D1 - GPIO5
#define BUZZER_PIN 15 // D8 - GPIO15

SoftwareSerial bioSerial(RX_PIN, TX_PIN);

// Buffer para respostas
byte responseBuffer[128];
int responseLength = 0;

// ========== VARIÁVEIS GLOBAIS ==========
byte genImg[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00};

// Estados para leitura contínua
unsigned long lastScanTime = 0;
const unsigned long SCAN_INTERVAL = 1500;
String lastFingerID = "";
unsigned long lastFingerTime = 0;
const unsigned long DEBOUNCE_TIME = 3000;

// Banco de dados local (ID -> Nome) - SALVO NA EEPROM!
String fingerprintDB[200];
const int EEPROM_SIZE = 4096;

// Controle de estado do sensor
bool sensorReady = false;
unsigned long lastSensorCheck = 0;
const unsigned long SENSOR_CHECK_INTERVAL = 5000;

// ✅ NOVO: Controle de limpeza de buffer
unsigned long lastBufferClear = 0;
const unsigned long BUFFER_CLEAR_INTERVAL = 5000;

// ========== DECLARAÇÕES DE FUNÇÕES ==========
void limparBufferSensor();
void checkSensorPeriodically();
void checkSensorStatus();
void processSerialCommands();
void continuousFingerprintScan();
bool captureFingerImage();
bool processAndSearchFingerprint();
void enrollFingerprint(String userName);
bool waitForFingerWithFeedback(int tentativa);
void feedbackRetireDedo();
void feedbackCriandoModelo();
void listAllFingerprints();
void deleteFingerprint(int id);
void deleteAllFingerprints();
void getTemplateCount();
void debugSensor();
bool verifyStoredFingerprint(int id);
void ledSucesso();
void ledErro();
void ledAtencao();
void sendCommand(byte cmd[], int length);
void readResponse();
bool waitForResponse();
uint16_t calculateChecksum(byte* packet, int length);
bool verifyPassword();
void carregarBancoDeDados();
void salvarBancoDeDados();
void saveToDatabase(int id, String name);
void removeFromDatabase(int id);
int findAvailableID();

void setup() {
  Serial.begin(115200);
  bioSerial.begin(57600);
  
  // Configurar pinos
  pinMode(POWER_PIN, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  digitalWrite(POWER_PIN, HIGH); // ✅ SEMPRE LIGADO!
  digitalWrite(LED_VERDE, LOW);
  digitalWrite(LED_VERMELHO, LOW);
  
  // Inicializar EEPROM
  EEPROM.begin(EEPROM_SIZE);
  carregarBancoDeDados();
  
  Serial.println("\n=== SISTEMA BIOMÉTRICO ===");
  Serial.println("Comandos disponíveis:");
  Serial.println("bio:Cadastrar:Nome");
  Serial.println("bio:Identificar");
  Serial.println("bio:Listar");
  Serial.println("bio:Deletar:ID");
  Serial.println("bio:Limpar");
  Serial.println("bio:Contar");
  Serial.println("bio:Debug");
  Serial.println("======================\n");
  
  delay(500);
  checkSensorStatus();
  
  Serial.println("Modo identificação: ATIVO");
}

void loop() {
  processSerialCommands();
  checkSensorPeriodically();
  
  // ✅ Limpa buffer periodicamente
  if (millis() - lastBufferClear >= BUFFER_CLEAR_INTERVAL) {
    lastBufferClear = millis();
    limparBufferSensor();
  }
  
  if (sensorReady) {
    continuousFingerprintScan();
  }
  
  delay(100);
}

// ========== EEPROM - PERSISTÊNCIA DE DADOS ==========
void carregarBancoDeDados() {
  Serial.println("Carregando banco de dados da EEPROM...");
  
  int endereco = 0;
  for (int i = 0; i < 200; i++) {
    fingerprintDB[i] = "";
    
    // Lê comprimento do nome
    int comprimento = EEPROM.read(endereco++);
    
    if (comprimento > 0 && comprimento < 100) {
      // Lê o nome
      for (int j = 0; j < comprimento; j++) {
        char c = EEPROM.read(endereco++);
        fingerprintDB[i] += c;
      }
    }
  }
  
  int count = 0;
  for (int i = 0; i < 200; i++) {
    if (fingerprintDB[i] != "") count++;
  }
  
  Serial.print("✓ ");
  Serial.print(count);
  Serial.println(" digitais carregadas da EEPROM");
}

void salvarBancoDeDados() {
  Serial.println("Salvando banco de dados na EEPROM...");
  
  int endereco = 0;
  for (int i = 0; i < 200; i++) {
    String nome = fingerprintDB[i];
    
    if (nome.length() > 0) {
      EEPROM.write(endereco++, nome.length());
      for (int j = 0; j < nome.length(); j++) {
        EEPROM.write(endereco++, nome[j]);
      }
    } else {
      EEPROM.write(endereco++, 0);
    }
  }
  
  EEPROM.commit();
  Serial.println("✓ Banco de dados salvo na EEPROM");
}

void saveToDatabase(int id, String name) {
  if (id >= 0 && id < 200) {
    fingerprintDB[id] = name;
    salvarBancoDeDados();
    Serial.print("✓ Salvo: ID ");
    Serial.print(id);
    Serial.print(" -> ");
    Serial.println(name);
  }
}

void removeFromDatabase(int id) {
  if (id >= 0 && id < 200) {
    fingerprintDB[id] = "";
    salvarBancoDeDados();
    Serial.print("✓ Removido: ID ");
    Serial.println(id);
  }
}

int findAvailableID() {
  for (int i = 0; i < 200; i++) {
    if (fingerprintDB[i] == "") {
      return i;
    }
  }
  return -1;
}

// ========== LIMPEZA DE BUFFER DO SENSOR ==========
void limparBufferSensor() {
  while(bioSerial.available()) {
    bioSerial.read();
  }
}

// ========== VERIFICAÇÃO DO SENSOR ==========
void checkSensorPeriodically() {
  unsigned long currentTime = millis();
  
  if (currentTime - lastSensorCheck >= SENSOR_CHECK_INTERVAL) {
    lastSensorCheck = currentTime;
    checkSensorStatus();
  }
}

void checkSensorStatus() {
  if (verifyPassword()) {
    if (!sensorReady) {
      Serial.println("✅ Sensor biométrico: CONECTADO");
      ledSucesso();
    }
    sensorReady = true;
  } else {
    if (sensorReady) {
      Serial.println("❌ Sensor biométrico: DESCONECTADO");
      ledErro();
    }
    sensorReady = false;
  }
}

// ========== PROCESSAMENTO DE COMANDOS ==========
void processSerialCommands() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    
    Serial.print("Comando recebido: ");
    Serial.println(command);
    
    if (command.startsWith("bio:")) {
      command.remove(0, 4);
      
      if (command.startsWith("Cadastrar:")) {
        command.remove(0, 10);
        command.trim();
        if (command.length() > 0) {
          Serial.print("Iniciando cadastro para: ");
          Serial.println(command);
          enrollFingerprint(command);
        } else {
          Serial.println("ERRO: Nome vazio");
        }
      }
      else if (command == "Identificar") {
        Serial.println("Modo identificação já está ativo");
      }
      else if (command == "Listar") {
        listAllFingerprints();
      }
      else if (command.startsWith("Deletar:")) {
        command.remove(0, 8);
        int id = command.toInt();
        Serial.print("Deletando ID: ");
        Serial.println(id);
        deleteFingerprint(id);
      }
      else if (command == "Limpar") {
        Serial.println("Limpando TODAS as digitais...");
        deleteAllFingerprints();
      }
      else if (command == "Contar") {
        getTemplateCount();
      }
      else if (command == "Debug") {
        debugSensor();
      }
      else {
        Serial.println("Comando inválido");
      }
    }
  }
}

// ========== LEITURA CONTÍNUA - CORRIGIDA ==========
void continuousFingerprintScan() {
  unsigned long currentTime = millis();
  
  if (currentTime - lastScanTime < SCAN_INTERVAL) {
    return;
  }
  
  lastScanTime = currentTime;
  
  if (captureFingerImage()) {
    processAndSearchFingerprint();
  } else {
    // ✅ SEMPRE limpa o buffer após tentar capturar
    limparBufferSensor();
  }
}

bool captureFingerImage() {
  sendCommand(genImg, 12);
  readResponse();
  
  if (responseLength >= 10) {
    if (responseBuffer[9] == 0x00) {
      return true;
    }
  }
  
  return false;
}

bool processAndSearchFingerprint() {
  // Gerar características
  byte img2tz[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x02, 0x01, 0x00, 0x00};
  sendCommand(img2tz, 13);
  
  if (!waitForResponse()) {
    limparBufferSensor(); // ✅ Limpa em caso de erro
    return false;
  }
  
  // Buscar no banco do sensor
  byte search[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x08, 0x04, 0x01, 
                   0x00, 0x00, 0x03, 0xE7, 0x00, 0x00};
  sendCommand(search, 17);
  readResponse();
  
  if (responseLength >= 16) {
    byte responseCode = responseBuffer[9];
    
    if (responseCode == 0x00) {
      // ✅ DIGITAL ENCONTRADA
      uint16_t fingerID = (responseBuffer[10] << 8) | responseBuffer[11];
      uint16_t matchScore = (responseBuffer[12] << 8) | responseBuffer[13];
      
      // ✅ Debounce: evita leituras repetidas
      if (millis() - lastFingerTime < DEBOUNCE_TIME && String(fingerID) == lastFingerID) {
        limparBufferSensor();
        return false;
      }
      
      lastFingerID = String(fingerID);
      lastFingerTime = millis();
      
      String userName = fingerprintDB[fingerID];
      
      if (userName == "") {
        Serial.print("🚫 Digital ID ");
        Serial.print(fingerID);
        Serial.println(" não cadastrada no sistema");
        
        digitalWrite(LED_VERMELHO, HIGH);
        tone(BUZZER_PIN, 300, 500);
        delay(600);
        digitalWrite(LED_VERMELHO, LOW);
        noTone(BUZZER_PIN);
        
      } else {
        Serial.println("\n=== ACESSO PERMITIDO ===");
        Serial.print("ID: ");
        Serial.println(fingerID);
        Serial.print("Nome: ");
        Serial.println(userName);
        Serial.print("Confiança: ");
        Serial.println(matchScore);
        Serial.println("========================\n");
        
        Serial.print("bio:Identificado:");
        Serial.print(fingerID);
        Serial.print(":");
        Serial.print(userName);
        Serial.print(":");
        Serial.println(matchScore);
        
        ledSucesso();
      }
      
      limparBufferSensor(); // ✅ Sempre limpa após processar
      delay(2000);
      return true;
      
    } else if (responseCode == 0x09) {
      // ✅ Digital não encontrada - DAR FEEDBACK!
      
      // Evita spam de bips (debounce)
      if (millis() - lastFingerTime > 2000) {
        Serial.println("🚫 Digital não cadastrada");
        
        // ✅ CORREÇÃO APLICADA: ENVIA PARA O SERVIDOR QUE O ACESSO FOI NEGADO
        Serial.println("ACESSO_NEGADO:DIGITAL_NAO_CADASTRADA");
        
        // Feedback visual e sonoro
        digitalWrite(LED_VERMELHO, HIGH);
        tone(BUZZER_PIN, 300, 300);
        delay(400);
        digitalWrite(LED_VERMELHO, LOW);
        noTone(BUZZER_PIN);
        
        lastFingerTime = millis();
      }
      
      limparBufferSensor();
      return false;
    } else {
      Serial.print("⚠ Erro na busca: 0x");
      Serial.println(responseCode, HEX);
      limparBufferSensor(); // ✅ Limpa o buffer
      return false;
    }
  }
  
  limparBufferSensor(); // ✅ Limpa o buffer
  return false;
}

// ========== CADASTRO DE DIGITAL COM FEEDBACK ==========
void enrollFingerprint(String userName) {
  Serial.println("\n=== INICIANDO CADASTRO ===");
  
  if (!sensorReady) {
    Serial.println("❌ ERRO: Sensor não está disponível");
    ledErro();
    return;
  }
  
  limparBufferSensor();
  
  int id = findAvailableID();
  if (id == -1) {
    Serial.println("ERRO: Banco de digitais cheio!");
    ledErro();
    return;
  }
  
  Serial.print("ID atribuído: ");
  Serial.println(id);
  Serial.println("\n>>> Coloque o dedo no sensor...");
  
  // ===== CAPTURA 1 COM FEEDBACK =====
  if (!waitForFingerWithFeedback(1)) {
    Serial.println("ERRO: Timeout na captura 1");
    ledErro();
    limparBufferSensor();
    return;
  }
  
  // Feedback: dedo detectado
  digitalWrite(LED_VERDE, HIGH);
  tone(BUZZER_PIN, 1200, 100);
  delay(150);
  noTone(BUZZER_PIN);
  
  Serial.println("✓ Dedo detectado!");
  Serial.println("Processando imagem 1...");
  
  byte img2tz1[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x02, 0x01, 0x00, 0x00};
  sendCommand(img2tz1, 13);
  
  if (!waitForResponse()) {
    Serial.println("ERRO: Falha ao processar imagem 1");
    digitalWrite(LED_VERDE, LOW);
    ledErro();
    limparBufferSensor();
    return;
  }
  
  digitalWrite(LED_VERDE, LOW);
  Serial.println("✓ Imagem 1 processada");
  Serial.println("\n>>> RETIRE o dedo...");
  
  // ✅ FEEDBACK: Retire o dedo
  feedbackRetireDedo();
  
  delay(2000);
  while(captureFingerImage()) {
    delay(100);
  }
  limparBufferSensor();
  
  Serial.println(">>> Coloque o MESMO dedo novamente...");
  
  // ===== CAPTURA 2 COM FEEDBACK =====
  if (!waitForFingerWithFeedback(2)) {
    Serial.println("ERRO: Timeout na captura 2");
    ledErro();
    limparBufferSensor();
    return;
  }
  
  // Feedback: dedo detectado
  digitalWrite(LED_VERDE, HIGH);
  tone(BUZZER_PIN, 1200, 100);
  delay(150);
  noTone(BUZZER_PIN);
  
  Serial.println("✓ Dedo detectado!");
  Serial.println("Processando imagem 2...");
  
  byte img2tz2[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x04, 0x02, 0x02, 0x00, 0x00};
  sendCommand(img2tz2, 13);
  
  if (!waitForResponse()) {
    Serial.println("ERRO: Falha ao processar imagem 2");
    digitalWrite(LED_VERDE, LOW);
    ledErro();
    limparBufferSensor();
    return;
  }
  
  digitalWrite(LED_VERDE, LOW);
  Serial.println("✓ Imagem 2 processada");
  
  // ===== CRIAR MODELO COM FEEDBACK =====
  Serial.println("Criando modelo biométrico...");
  feedbackCriandoModelo();
  
  byte regModel[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x05, 0x00, 0x00};
  sendCommand(regModel, 12);
  
  if (!waitForResponse()) {
    Serial.println("ERRO: Falha ao criar modelo (digitais não coincidem?)");
    ledErro();
    limparBufferSensor();
    return;
  }
  
  Serial.println("✓ Modelo criado");
  
  // ===== ARMAZENAR NO SENSOR =====
  Serial.println("Armazenando no sensor...");
  
  byte store[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x06, 0x06, 0x01, 
                  (byte)((id >> 8) & 0xFF), (byte)(id & 0xFF), 0x00, 0x00};
  sendCommand(store, 15);
  
  if (!waitForResponse()) {
    Serial.println("ERRO: Falha ao armazenar no sensor");
    ledErro();
    limparBufferSensor();
    return;
  }
  
  Serial.println("✓ Digital armazenada no sensor");
  
  // ===== VERIFICAR ARMAZENAMENTO =====
  delay(500);
  if (!verifyStoredFingerprint(id)) {
    Serial.println("ERRO: Verificação falhou");
    ledErro();
    limparBufferSensor();
    return;
  }
  
  // ✅ SALVA NO BANCO LOCAL (EEPROM)
  saveToDatabase(id, userName);
  
  Serial.println("\n=== CADASTRO CONCLUÍDO ===");
  Serial.print("ID: ");
  Serial.print(id);
  Serial.print(" | Nome: ");
  Serial.println(userName);
  Serial.println("==========================\n");
  
  Serial.println("cadastrado com sucesso");
  Serial.println("Nome: " + userName);
  Serial.print("ID: ");
  Serial.println(id);
  
  ledSucesso();
  limparBufferSensor();
  
  delay(2000);
  lastFingerID = "";
  lastFingerTime = 0;
}

// ========== FEEDBACKS VISUAIS E SONOROS ==========
bool waitForFingerWithFeedback(int tentativa) {
  Serial.println("Aguardando dedo no sensor...");
  
  unsigned long startTime = millis();
  const unsigned long TIMEOUT = 30000; // 30 segundos
  unsigned long lastBeep = 0;
  bool ledState = false;
  
  while (millis() - startTime < TIMEOUT) {
    unsigned long currentTime = millis();
    
    // ✅ LED piscando (500ms)
    if (currentTime - lastBeep >= 500) {
      ledState = !ledState;
      digitalWrite(LED_VERDE, ledState ? HIGH : LOW);
      lastBeep = currentTime;
      
      // ✅ Bip suave a cada 2 segundos
      if (ledState && (currentTime - startTime) % 2000 < 500) {
        int frequencia = (tentativa == 1) ? 800 : 900;
        tone(BUZZER_PIN, frequencia, 100);
      }
    }
    
    sendCommand(genImg, 12);
    readResponse();
    
    if (responseLength >= 10 && responseBuffer[9] == 0x00) {
      digitalWrite(LED_VERDE, LOW);
      noTone(BUZZER_PIN);
      return true;
    }
    
    delay(300);
  }
  
  digitalWrite(LED_VERDE, LOW);
  noTone(BUZZER_PIN);
  Serial.println("Timeout - Nenhum dedo detectado");
  return false;
}

void feedbackRetireDedo() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_VERMELHO, HIGH);
    tone(BUZZER_PIN, 600, 100);
    delay(200);
    digitalWrite(LED_VERMELHO, LOW);
    noTone(BUZZER_PIN);
    delay(100);
  }
}

void feedbackCriandoModelo() {
  // Tom progressivo
  for (int freq = 500; freq <= 1500; freq += 100) {
    digitalWrite(LED_VERDE, HIGH);
    digitalWrite(LED_VERMELHO, LOW);
    tone(BUZZER_PIN, freq, 50);
    delay(80);
    
    digitalWrite(LED_VERDE, LOW);
    digitalWrite(LED_VERMELHO, HIGH);
    delay(80);
  }
  
  digitalWrite(LED_VERMELHO, LOW);
  noTone(BUZZER_PIN);
}

// ========== FUNÇÕES DE MANUTENÇÃO ==========
void listAllFingerprints() {
  Serial.println("\n=== DIGITAIS CADASTRADAS ===");
  int count = 0;
  
  for (int i = 0; i < 200; i++) {
    if (fingerprintDB[i] != "") {
      Serial.print("ID ");
      if (i < 10) Serial.print("00");
      else if (i < 100) Serial.print("0");
      Serial.print(i);
      Serial.print(": ");
      Serial.println(fingerprintDB[i]);
      count++;
    }
  }
  
  if (count == 0) {
    Serial.println("Nenhuma digital cadastrada");
  } else {
    Serial.print("\nTotal: ");
    Serial.println(count);
  }
  Serial.println("============================\n");
  
  Serial.print("bio:Lista:Total:");
  Serial.println(count);
}

void deleteFingerprint(int id) {
  if (id < 0 || id > 199) {
    Serial.println("ERRO: ID inválido (0-199)");
    return;
  }
  
  if (fingerprintDB[id] == "") {
    Serial.println("ERRO: ID não existe no banco local");
    return;
  }
  
  Serial.print("Deletando ID ");
  Serial.print(id);
  Serial.print(" (");
  Serial.print(fingerprintDB[id]);
  Serial.println(")...");
  
  byte deleteCmd[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x07, 0x0C,
                      (byte)((id >> 8) & 0xFF), (byte)(id & 0xFF), 0x00, 0x01, 0x00, 0x00};
  sendCommand(deleteCmd, 16);
  
  if (waitForResponse()) {
    String nome = fingerprintDB[id];
    removeFromDatabase(id);
    
    Serial.println("Usuário removido: " + nome);
    Serial.print("bio:Deletado:");
    Serial.println(id);
    
    ledSucesso();
  } else {
    Serial.println("ERRO: Falha ao deletar do sensor");
    ledErro();
  }
  
  limparBufferSensor();
}

void deleteAllFingerprints() {
  Serial.println("\n=== DELETANDO TODAS AS DIGITAIS ===");
  
  byte empty[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x0D, 0x00, 0x00};
  sendCommand(empty, 12);
  
  if (waitForResponse()) {
    // Limpa EEPROM
    for (int i = 0; i < 200; i++) {
      fingerprintDB[i] = "";
    }
    salvarBancoDeDados();
    
    Serial.println("Todos os usuários foram removidos");
    Serial.println("bio:Limpo:OK");
    ledAtencao();
  } else {
    Serial.println("ERRO: Falha ao limpar banco do sensor");
    ledErro();
  }
  
  limparBufferSensor();
}

void getTemplateCount() {
  Serial.println("\nContando digitais...");
  
  byte count[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x1D, 0x00, 0x00};
  sendCommand(count, 12);
  readResponse();
  
  int sensorCount = 0;
  if (responseLength >= 14 && responseBuffer[9] == 0x00) {
    sensorCount = (responseBuffer[10] << 8) | responseBuffer[11];
  }
  
  int localCount = 0;
  for (int i = 0; i < 200; i++) {
    if (fingerprintDB[i] != "") localCount++;
  }
  
  Serial.print("No sensor: ");
  Serial.print(sensorCount);
  Serial.print(" | No banco local: ");
  Serial.println(localCount);
  
  if (sensorCount != localCount) {
    Serial.println("⚠ AVISO: Inconsistência detectada!");
  }
  
  Serial.print("bio:Contagem:");
  Serial.println(localCount);
}

void debugSensor() {
  Serial.println("\n=== DEBUG DO SENSOR ===");
  
  Serial.println("1. Testando comunicação...");
  if (verifyPassword()) {
    Serial.println("   ✓ Sensor respondendo");
  } else {
    Serial.println("   ✗ Sensor não responde");
    return;
  }
  
  Serial.println("2. Contando digitais no sensor...");
  byte count[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x03, 0x1D, 0x00, 0x00};
  sendCommand(count, 12);
  readResponse();
  
  if (responseLength >= 14 && responseBuffer[9] == 0x00) {
    uint16_t templateCount = (responseBuffer[10] << 8) | responseBuffer[11];
    Serial.print("   ✓ Templates no sensor: ");
    Serial.println(templateCount);
  }
  
  Serial.println("3. Verificando EEPROM...");
  int localCount = 0;
  for (int i = 0; i < 200; i++) {
    if (fingerprintDB[i] != "") {
      Serial.print("   ID ");
      Serial.print(i);
      Serial.print(": ");
      Serial.println(fingerprintDB[i]);
      localCount++;
    }
  }
  Serial.print("   Total na EEPROM: ");
  Serial.println(localCount);
  
  Serial.println("=== FIM DEBUG ===\n");
}

bool verifyStoredFingerprint(int id) {
  Serial.print("Verificando armazenamento do ID ");
  Serial.print(id);
  Serial.println("...");
  
  byte loadTemplate[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x06, 0x07, 0x01,
                         (byte)((id >> 8) & 0xFF), (byte)(id & 0xFF), 0x00, 0x00};
  sendCommand(loadTemplate, 15);
  readResponse();
  
  if (responseLength >= 10 && responseBuffer[9] == 0x00) {
    Serial.println("✓ Digital confirmada no sensor");
    return true;
  }
  
  Serial.println("✗ Falha na verificação");
  return false;
}

// ========== FUNÇÕES LED E BUZZER ==========
void ledSucesso() {
  digitalWrite(LED_VERDE, HIGH);
  digitalWrite(LED_VERMELHO, LOW);
  
  tone(BUZZER_PIN, 1000, 150);
  delay(200);
  tone(BUZZER_PIN, 1500, 200);
  delay(250);
  noTone(BUZZER_PIN);
  
  delay(300);
  digitalWrite(LED_VERDE, LOW);
}

void ledErro() {
  digitalWrite(LED_VERMELHO, HIGH);
  digitalWrite(LED_VERDE, LOW);
  
  tone(BUZZER_PIN, 400, 200);
  delay(200);
  tone(BUZZER_PIN, 600, 300);
  delay(150);
  noTone(BUZZER_PIN);
  
  delay(300);
  digitalWrite(LED_VERMELHO, LOW);
}

void ledAtencao() {
  for(int i = 0; i < 3; i++) {
    digitalWrite(LED_VERDE, HIGH);
    tone(BUZZER_PIN, 1200, 100);
    delay(200);
    digitalWrite(LED_VERDE, LOW);
    
    digitalWrite(LED_VERMELHO, HIGH);
    tone(BUZZER_PIN, 1000, 100);
    delay(200);
    digitalWrite(LED_VERMELHO, LOW);
  }
  noTone(BUZZER_PIN);
}

// ========== FUNÇÕES DO SENSOR ==========
void sendCommand(byte cmd[], int length) {
  uint16_t checksum = calculateChecksum(cmd, length);
  cmd[length - 2] = (checksum >> 8) & 0xFF;
  cmd[length - 1] = checksum & 0xFF;
  
  limparBufferSensor();
  
  for (int i = 0; i < length; i++) {
    bioSerial.write(cmd[i]);
  }
  
  delay(100);
}

void readResponse() {
  responseLength = 0;
  unsigned long timeout = millis() + 1000;
  
  while (millis() < timeout && responseLength < 128) {
    if (bioSerial.available()) {
      responseBuffer[responseLength++] = bioSerial.read();
      timeout = millis() + 100;
    }
  }
}

bool waitForResponse() {
  readResponse();
  
  if (responseLength >= 10) {
    byte confirmCode = responseBuffer[9];
    
    if (confirmCode != 0x00) {
      Serial.print("⚠ Código de erro do sensor: 0x");
      Serial.println(confirmCode, HEX);
      
      switch(confirmCode) {
        case 0x01: Serial.println("   (Erro ao receber pacote)"); break;
        case 0x02: Serial.println("   (Nenhum dedo no sensor)"); break;
        case 0x03: Serial.println("   (Falha ao capturar)"); break;
        case 0x06: Serial.println("   (Imagem muito bagunçada)"); break;
        case 0x07: Serial.println("   (Poucos pontos característicos)"); break;
        case 0x08: Serial.println("   (Digitais não coincidem)"); break;
        case 0x09: Serial.println("   (Digital não encontrada)"); break;
        case 0x0A: Serial.println("   (Falha ao combinar)"); break;
        case 0x0B: Serial.println("   (ID inválido)"); break;
        case 0x10: Serial.println("   (Falha ao deletar)"); break;
        case 0x11: Serial.println("   (Falha ao limpar)"); break;
        case 0x15: Serial.println("   (Buffer de imagem inválido)"); break;
        case 0x18: Serial.println("   (Erro ao escrever flash)"); break;
      }
    }
    
    return (confirmCode == 0x00);
  }
  
  Serial.println("⚠ Timeout - Sem resposta do sensor");
  return false;
}

uint16_t calculateChecksum(byte* packet, int length) {
  uint16_t sum = 0;
  for (int i = 6; i < length - 2; i++) {
    sum += packet[i];
  }
  return sum;
}

bool verifyPassword() {
  byte cmd[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x07, 0x13, 
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  sendCommand(cmd, 16);
  return waitForResponse();
}