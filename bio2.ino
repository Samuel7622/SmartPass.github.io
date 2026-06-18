#include <SoftwareSerial.h>
#include <EEPROM.h>

// ========== CONFIGURAÇÃO DOS PINOS ==========
#define RX_PIN       14   // GPIO14 (D5)
#define TX_PIN       12   // GPIO12 (D6)
#define POWER_PIN    13   // GPIO13 (D7) - SEMPRE HIGH!
#define LED_VERDE     4   // D2 - GPIO4
#define LED_VERMELHO  5   // D1 - GPIO5
#define BUZZER_PIN   15   // D8 - GPIO15

SoftwareSerial bioSerial(RX_PIN, TX_PIN);

// ========== BUFFERS ==========
byte responseBuffer[128];
int  responseLength = 0;
byte genImg[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x03,0x01,0x00,0x00};

// ========== BANCO LOCAL (EEPROM) — usado APENAS para cadastro ==========
// Durante identificação o servidor é quem sabe o nome pelo bio_id.
// A EEPROM continua sendo usada para que enrollFingerprint() encontre
// um ID livre e para que deleteFingerprint() saiba qual slot apagar.
String fingerprintDB[200];
const int EEPROM_SIZE = 4096;

// ========== ESTADO DE SCAN ==========
unsigned long lastScanTime  = 0;
const unsigned long SCAN_INTERVAL = 1500;

unsigned long lastFingerTime = 0;
int           lastFingerID   = -1;
const unsigned long DEBOUNCE_TIME = 3000;

// ========== ESTADO DO SENSOR ==========
bool sensorReady = false;
unsigned long lastSensorCheck = 0;
const unsigned long SENSOR_CHECK_INTERVAL = 5000;

unsigned long lastBufferClear = 0;
const unsigned long BUFFER_CLEAR_INTERVAL = 5000;

// ========== DECLARAÇÕES ==========
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
int  findAvailableID();

// ========== SETUP ==========
void setup() {
    Serial.begin(115200);
    bioSerial.begin(57600);

    pinMode(POWER_PIN,    OUTPUT);
    pinMode(LED_VERDE,    OUTPUT);
    pinMode(LED_VERMELHO, OUTPUT);
    pinMode(BUZZER_PIN,   OUTPUT);

    digitalWrite(POWER_PIN,    HIGH);
    digitalWrite(LED_VERDE,    LOW);
    digitalWrite(LED_VERMELHO, LOW);

    EEPROM.begin(EEPROM_SIZE);
    carregarBancoDeDados();

    Serial.println("\n=== SISTEMA BIOMETRICO ===");
    Serial.println("Comandos:");
    Serial.println("bio:Cadastrar:Nome");
    Serial.println("bio:Listar");
    Serial.println("bio:Deletar:ID");
    Serial.println("bio:Limpar");
    Serial.println("bio:Contar");
    Serial.println("bio:Debug");
    Serial.println("=========================\n");

    delay(500);
    checkSensorStatus();
    Serial.println("Modo identificacao: ATIVO");
}

// ========== LOOP ==========
void loop() {
    processSerialCommands();
    checkSensorPeriodically();

    if (millis() - lastBufferClear >= BUFFER_CLEAR_INTERVAL) {
        lastBufferClear = millis();
        limparBufferSensor();
    }

    if (sensorReady) {
        continuousFingerprintScan();
    }

    delay(100);
}

// ========== EEPROM ==========
void carregarBancoDeDados() {
    int addr = 0;
    for (int i = 0; i < 200; i++) {
        fingerprintDB[i] = "";
        int len = EEPROM.read(addr++);
        if (len > 0 && len < 100) {
            for (int j = 0; j < len; j++) fingerprintDB[i] += (char)EEPROM.read(addr++);
        }
    }
    int count = 0;
    for (int i = 0; i < 200; i++) if (fingerprintDB[i] != "") count++;
    Serial.print("✓ "); Serial.print(count); Serial.println(" digitais carregadas da EEPROM");
}

void salvarBancoDeDados() {
    int addr = 0;
    for (int i = 0; i < 200; i++) {
        String nome = fingerprintDB[i];
        if (nome.length() > 0) {
            EEPROM.write(addr++, nome.length());
            for (int j = 0; j < (int)nome.length(); j++) EEPROM.write(addr++, nome[j]);
        } else {
            EEPROM.write(addr++, 0);
        }
    }
    EEPROM.commit();
}

void saveToDatabase(int id, String name) {
    if (id >= 0 && id < 200) { fingerprintDB[id] = name; salvarBancoDeDados(); }
}

void removeFromDatabase(int id) {
    if (id >= 0 && id < 200) { fingerprintDB[id] = ""; salvarBancoDeDados(); }
}

int findAvailableID() {
    for (int i = 0; i < 200; i++) if (fingerprintDB[i] == "") return i;
    return -1;
}

// ========== UTILITÁRIOS ==========
void limparBufferSensor() {
    while (bioSerial.available()) bioSerial.read();
}

void checkSensorPeriodically() {
    if (millis() - lastSensorCheck >= SENSOR_CHECK_INTERVAL) {
        lastSensorCheck = millis();
        checkSensorStatus();
    }
}

void checkSensorStatus() {
    if (verifyPassword()) {
        if (!sensorReady) { Serial.println("✅ Sensor biometrico: CONECTADO"); ledSucesso(); }
        sensorReady = true;
    } else {
        if (sensorReady) { Serial.println("❌ Sensor biometrico: DESCONECTADO"); ledErro(); }
        sensorReady = false;
    }
}

// ========== COMANDOS SERIAL ==========
void processSerialCommands() {
    if (!Serial.available()) return;
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    Serial.print("Comando recebido: "); Serial.println(cmd);
    if (!cmd.startsWith("bio:")) return;
    cmd.remove(0, 4);

    if (cmd.startsWith("Cadastrar:")) {
        cmd.remove(0, 10); cmd.trim();
        if (cmd.length() > 0) enrollFingerprint(cmd);
        else Serial.println("ERRO: Nome vazio");
    } else if (cmd == "Listar") {
        listAllFingerprints();
    } else if (cmd.startsWith("Deletar:")) {
        cmd.remove(0, 8);
        deleteFingerprint(cmd.toInt());
    } else if (cmd == "Limpar") {
        deleteAllFingerprints();
    } else if (cmd == "Contar") {
        getTemplateCount();
    } else if (cmd == "Debug") {
        debugSensor();
    } else {
        Serial.println("Comando invalido");
    }
}

// ========== SCAN CONTÍNUO ==========
void continuousFingerprintScan() {
    if (millis() - lastScanTime < SCAN_INTERVAL) return;
    lastScanTime = millis();
    if (captureFingerImage()) processAndSearchFingerprint();
    else limparBufferSensor();
}

bool captureFingerImage() {
    sendCommand(genImg, 12);
    readResponse();
    return (responseLength >= 10 && responseBuffer[9] == 0x00);
}

// ========== IDENTIFICAÇÃO — envia bio:ID: e aguarda resposta do servidor ==========
bool processAndSearchFingerprint() {
    // Gerar características
    byte img2tz[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x04,0x02,0x01,0x00,0x00};
    sendCommand(img2tz, 13);
    if (!waitForResponse()) { limparBufferSensor(); return false; }

    // Buscar no sensor
    byte search[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x08,0x04,0x01,
                     0x00,0x00,0x03,0xE7,0x00,0x00};
    sendCommand(search, 17);
    readResponse();

    if (responseLength < 16) { limparBufferSensor(); return false; }

    byte code = responseBuffer[9];

    if (code == 0x00) {
        // Digital encontrada no sensor
        uint16_t fingerID   = (responseBuffer[10] << 8) | responseBuffer[11];
        uint16_t matchScore = (responseBuffer[12] << 8) | responseBuffer[13];

        // Debounce
        if ((int)fingerID == lastFingerID && millis() - lastFingerTime < DEBOUNCE_TIME) {
            limparBufferSensor();
            return false;
        }
        lastFingerID   = (int)fingerID;
        lastFingerTime = millis();

        Serial.print("Digital encontrada | ID: ");
        Serial.print(fingerID);
        Serial.print(" | Score: ");
        Serial.println(matchScore);

        // Envia o ID para o servidor e aguarda resposta
        Serial.print("bio:ID:");
        Serial.println(fingerID);

        // Aguarda RESPOSTA_ACESSO: do servidor (até 2 segundos)
        unsigned long inicio = millis();
        bool respostaRecebida = false;
        String resposta = "";
        while (millis() - inicio < 2000) {
            if (Serial.available()) {
                resposta = Serial.readStringUntil('\n');
                resposta.trim();
                if (resposta.startsWith("RESPOSTA_ACESSO:")) {
                    respostaRecebida = true;
                    break;
                }
            }
        }
        if (!respostaRecebida) resposta = "RESPOSTA_ACESSO:NAO:TIMEOUT";

        if (resposta.indexOf(":SIM:") > 0) {
            ledSucesso();
        } else {
            ledErro();
        }

        limparBufferSensor();
        delay(2000);
        return true;

    } else if (code == 0x09) {
        // Digital não encontrada no sensor
        if (millis() - lastFingerTime > 2000) {
            Serial.println("Digital nao cadastrada no sensor");
            // Avisa o servidor
            Serial.println("bio:ID:NAO_CADASTRADO");
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
        limparBufferSensor();
        return false;
    }
}

// ========== CADASTRO ==========
void enrollFingerprint(String userName) {
    Serial.println("\n=== INICIANDO CADASTRO ===");
    if (!sensorReady) { Serial.println("ERRO: Sensor nao disponivel"); ledErro(); return; }

    limparBufferSensor();
    int id = findAvailableID();
    if (id == -1) { Serial.println("ERRO: Banco cheio!"); ledErro(); return; }

    Serial.print("ID atribuido: "); Serial.println(id);
    Serial.println("\n>>> Coloque o dedo no sensor...");

    // Captura 1
    if (!waitForFingerWithFeedback(1)) { Serial.println("ERRO: Timeout captura 1"); ledErro(); limparBufferSensor(); return; }
    digitalWrite(LED_VERDE, HIGH); tone(BUZZER_PIN, 1200, 100); delay(150); noTone(BUZZER_PIN);
    Serial.println("✓ Dedo detectado!");

    byte img2tz1[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x04,0x02,0x01,0x00,0x00};
    sendCommand(img2tz1, 13);
    if (!waitForResponse()) { Serial.println("ERRO: Falha imagem 1"); digitalWrite(LED_VERDE,LOW); ledErro(); limparBufferSensor(); return; }
    digitalWrite(LED_VERDE, LOW);
    Serial.println("✓ Imagem 1 processada");
    Serial.println("\n>>> RETIRE o dedo...");
    feedbackRetireDedo();
    delay(2000);
    while (captureFingerImage()) delay(100);
    limparBufferSensor();

    Serial.println(">>> Coloque o MESMO dedo novamente...");

    // Captura 2
    if (!waitForFingerWithFeedback(2)) { Serial.println("ERRO: Timeout captura 2"); ledErro(); limparBufferSensor(); return; }
    digitalWrite(LED_VERDE, HIGH); tone(BUZZER_PIN, 1200, 100); delay(150); noTone(BUZZER_PIN);
    Serial.println("✓ Dedo detectado!");

    byte img2tz2[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x04,0x02,0x02,0x00,0x00};
    sendCommand(img2tz2, 13);
    if (!waitForResponse()) { Serial.println("ERRO: Falha imagem 2"); digitalWrite(LED_VERDE,LOW); ledErro(); limparBufferSensor(); return; }
    digitalWrite(LED_VERDE, LOW);
    Serial.println("✓ Imagem 2 processada");

    // Criar modelo
    Serial.println("Criando modelo biometrico...");
    feedbackCriandoModelo();
    byte regModel[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x03,0x05,0x00,0x00};
    sendCommand(regModel, 12);
    if (!waitForResponse()) { Serial.println("ERRO: Digitais nao coincidem"); ledErro(); limparBufferSensor(); return; }
    Serial.println("✓ Modelo criado");

    // Armazenar
    Serial.println("Armazenando no sensor...");
    byte store[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x06,0x06,0x01,
                    (byte)((id>>8)&0xFF),(byte)(id&0xFF),0x00,0x00};
    sendCommand(store, 15);
    if (!waitForResponse()) { Serial.println("ERRO: Falha ao armazenar"); ledErro(); limparBufferSensor(); return; }
    Serial.println("✓ Digital armazenada no sensor");

    // Verificar
    delay(500);
    if (!verifyStoredFingerprint(id)) { Serial.println("ERRO: Verificacao falhou"); ledErro(); limparBufferSensor(); return; }

    // Salva na EEPROM (para controle de IDs livres)
    saveToDatabase(id, userName);

    Serial.println("\n=== CADASTRO CONCLUIDO ===");
    Serial.print("ID: "); Serial.print(id);
    Serial.print(" | Nome: "); Serial.println(userName);
    Serial.println("==========================\n");
    Serial.println("cadastrado com sucesso");
    Serial.print("ID: "); Serial.println(id);

    ledSucesso();
    limparBufferSensor();
    delay(2000);
    lastFingerID   = -1;
    lastFingerTime = 0;
}

// ========== FEEDBACKS ==========
bool waitForFingerWithFeedback(int tentativa) {
    unsigned long startTime = millis();
    unsigned long lastBeep  = 0;
    bool ledState = false;
    while (millis() - startTime < 30000) {
        unsigned long now = millis();
        if (now - lastBeep >= 500) {
            ledState = !ledState;
            digitalWrite(LED_VERDE, ledState ? HIGH : LOW);
            lastBeep = now;
            if (ledState && (now - startTime) % 2000 < 500)
                tone(BUZZER_PIN, tentativa == 1 ? 800 : 900, 100);
        }
        sendCommand(genImg, 12);
        readResponse();
        if (responseLength >= 10 && responseBuffer[9] == 0x00) {
            digitalWrite(LED_VERDE, LOW); noTone(BUZZER_PIN); return true;
        }
        delay(300);
    }
    digitalWrite(LED_VERDE, LOW); noTone(BUZZER_PIN);
    Serial.println("Timeout - Nenhum dedo detectado");
    return false;
}

void feedbackRetireDedo() {
    for (int i = 0; i < 3; i++) {
        digitalWrite(LED_VERMELHO, HIGH); tone(BUZZER_PIN, 600, 100); delay(200);
        digitalWrite(LED_VERMELHO, LOW);  noTone(BUZZER_PIN);          delay(100);
    }
}

void feedbackCriandoModelo() {
    for (int freq = 500; freq <= 1500; freq += 100) {
        digitalWrite(LED_VERDE,    HIGH); digitalWrite(LED_VERMELHO, LOW);
        tone(BUZZER_PIN, freq, 50); delay(80);
        digitalWrite(LED_VERDE,    LOW);  digitalWrite(LED_VERMELHO, HIGH); delay(80);
    }
    digitalWrite(LED_VERMELHO, LOW); noTone(BUZZER_PIN);
}

// ========== MANUTENÇÃO ==========
void listAllFingerprints() {
    int count = 0;
    Serial.println("\n=== DIGITAIS CADASTRADAS ===");
    for (int i = 0; i < 200; i++) {
        if (fingerprintDB[i] != "") {
            Serial.print("ID "); Serial.print(i); Serial.print(": "); Serial.println(fingerprintDB[i]);
            count++;
        }
    }
    if (count == 0) Serial.println("Nenhuma digital cadastrada");
    Serial.print("Total: "); Serial.println(count);
    Serial.println("============================\n");
    Serial.print("bio:Lista:Total:"); Serial.println(count);
}

void deleteFingerprint(int id) {
    if (id < 0 || id > 199) { Serial.println("ERRO: ID invalido (0-199)"); return; }
    if (fingerprintDB[id] == "") { Serial.println("ERRO: ID nao existe"); return; }

    byte deleteCmd[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x07,0x0C,
                        (byte)((id>>8)&0xFF),(byte)(id&0xFF),0x00,0x01,0x00,0x00};
    sendCommand(deleteCmd, 16);
    if (waitForResponse()) {
        String nome = fingerprintDB[id];
        removeFromDatabase(id);
        Serial.println("Usuário removido: " + nome);
        Serial.print("bio:Deletado:"); Serial.println(id);
        ledSucesso();
    } else {
        Serial.println("ERRO: Falha ao deletar do sensor");
        ledErro();
    }
    limparBufferSensor();
}

void deleteAllFingerprints() {
    byte empty[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x03,0x0D,0x00,0x00};
    sendCommand(empty, 12);
    if (waitForResponse()) {
        for (int i = 0; i < 200; i++) fingerprintDB[i] = "";
        salvarBancoDeDados();
        Serial.println("Todos os usuários foram removidos");
        Serial.println("bio:Limpo:OK");
        ledAtencao();
    } else {
        Serial.println("ERRO: Falha ao limpar sensor");
        ledErro();
    }
    limparBufferSensor();
}

void getTemplateCount() {
    byte count[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x03,0x1D,0x00,0x00};
    sendCommand(count, 12);
    readResponse();
    int sensorCount = 0;
    if (responseLength >= 14 && responseBuffer[9] == 0x00)
        sensorCount = (responseBuffer[10] << 8) | responseBuffer[11];
    int localCount = 0;
    for (int i = 0; i < 200; i++) if (fingerprintDB[i] != "") localCount++;
    Serial.print("No sensor: "); Serial.print(sensorCount);
    Serial.print(" | Na EEPROM: "); Serial.println(localCount);
    Serial.print("bio:Contagem:"); Serial.println(localCount);
}

void debugSensor() {
    Serial.println("\n=== DEBUG ===");
    if (verifyPassword()) Serial.println("✓ Sensor respondendo");
    else { Serial.println("✗ Sensor nao responde"); return; }
    getTemplateCount();
    Serial.println("=== FIM DEBUG ===\n");
}

bool verifyStoredFingerprint(int id) {
    byte loadTemplate[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x06,0x07,0x01,
                           (byte)((id>>8)&0xFF),(byte)(id&0xFF),0x00,0x00};
    sendCommand(loadTemplate, 15);
    readResponse();
    if (responseLength >= 10 && responseBuffer[9] == 0x00) {
        Serial.println("✓ Digital confirmada no sensor"); return true;
    }
    Serial.println("✗ Falha na verificacao"); return false;
}

// ========== LEDs e BUZZER ==========
void ledSucesso() {
    digitalWrite(LED_VERDE,    HIGH); digitalWrite(LED_VERMELHO, LOW);
    tone(BUZZER_PIN, 1000, 150); delay(200);
    tone(BUZZER_PIN, 1500, 200); delay(250); noTone(BUZZER_PIN);
    delay(300); digitalWrite(LED_VERDE, LOW);
}

void ledErro() {
    digitalWrite(LED_VERMELHO, HIGH); digitalWrite(LED_VERDE, LOW);
    tone(BUZZER_PIN, 400, 200); delay(200);
    tone(BUZZER_PIN, 600, 300); delay(150); noTone(BUZZER_PIN);
    delay(300); digitalWrite(LED_VERMELHO, LOW);
}

void ledAtencao() {
    for (int i = 0; i < 3; i++) {
        digitalWrite(LED_VERDE,    HIGH); tone(BUZZER_PIN, 1200, 100); delay(200); digitalWrite(LED_VERDE,    LOW);
        digitalWrite(LED_VERMELHO, HIGH); tone(BUZZER_PIN, 1000, 100); delay(200); digitalWrite(LED_VERMELHO, LOW);
    }
    noTone(BUZZER_PIN);
}

// ========== COMUNICAÇÃO COM SENSOR ==========
void sendCommand(byte cmd[], int length) {
    uint16_t checksum = calculateChecksum(cmd, length);
    cmd[length-2] = (checksum >> 8) & 0xFF;
    cmd[length-1] =  checksum       & 0xFF;
    limparBufferSensor();
    for (int i = 0; i < length; i++) bioSerial.write(cmd[i]);
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
        byte code = responseBuffer[9];
        if (code != 0x00) { Serial.print("Erro sensor: 0x"); Serial.println(code, HEX); }
        return (code == 0x00);
    }
    Serial.println("Timeout - Sem resposta do sensor");
    return false;
}

uint16_t calculateChecksum(byte* packet, int length) {
    uint16_t sum = 0;
    for (int i = 6; i < length - 2; i++) sum += packet[i];
    return sum;
}

bool verifyPassword() {
    byte cmd[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,0x01,0x00,0x07,0x13,
                  0x00,0x00,0x00,0x00,0x00,0x00};
    sendCommand(cmd, 16);
    return waitForResponse();
}
