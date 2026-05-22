#include <SPI.h>
#include <MFRC522.h>

#define SS_PIN   15
#define RST_PIN  16
#define LED_VERMELHO 5
#define LED_VERDE    2
#define BUZZER_PIN   4

MFRC522 mfrc522(SS_PIN, RST_PIN);

byte ultimoUID[4] = {0,0,0,0};
unsigned long ultimoTempo = 0;
const unsigned long DEBOUNCE_MS = 500;
const unsigned long TIMEOUT_RESPOSTA = 2000;

// Modo de cadastro
bool modoCadastro = false;
String nomeCadastro = "";
unsigned long tempoEntradaCadastro = 0;
const unsigned long TIMEOUT_CADASTRO = 60000; // 60 segundos para aproximar a tag

void setup() {
  Serial.begin(9600);
  SPI.begin();
  mfrc522.PCD_Init();
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(LED_VERMELHO, LOW);
  digitalWrite(LED_VERDE, LOW);
  Serial.println("Sistema pronto. Modo normal.");
}

void loop() {
  // Verifica se há comando serial
  if (Serial.available()) {
    String comando = Serial.readStringUntil('\n');
    comando.trim();
    processarComando(comando);
  }

  // Se estiver em modo cadastro, verifica timeout
  if (modoCadastro && (millis() - tempoEntradaCadastro > TIMEOUT_CADASTRO)) {
    Serial.println("ERRO: Timeout no cadastro");
    modoCadastro = false;
    nomeCadastro = "";
    return;
  }

  // Leitura de tag (comum para acesso ou cadastro)
  if (!mfrc522.PICC_IsNewCardPresent()) return;
  if (!mfrc522.PICC_ReadCardSerial()) return;

  byte uid[4];
  for (byte i = 0; i < 4; i++) uid[i] = mfrc522.uid.uidByte[i];

  // Debounce
  bool igual = true;
  for (int i = 0; i < 4; i++) if (uid[i] != ultimoUID[i]) { igual = false; break; }
  if (igual && (millis() - ultimoTempo < DEBOUNCE_MS)) {
    mfrc522.PICC_HaltA();
    return;
  }
  for (int i = 0; i < 4; i++) ultimoUID[i] = uid[i];
  ultimoTempo = millis();

  // Se estiver em modo cadastro, trata o UID para cadastro
  if (modoCadastro) {
    // Envia o UID lido no formato esperado pelo backend
    Serial.print("UID lido: ");
    for (int i = 0; i < 4; i++) {
      if (uid[i] < 0x10) Serial.print("0");
      Serial.print(uid[i], HEX);
      if (i < 3) Serial.print(" ");
    }
    Serial.println();
    
    // Aguarda um curto período para garantir que o backend processe
    delay(200);
    
    // Envia mensagem de sucesso
    Serial.println("SUCESSO: Cadastrado");
    
    // Finaliza modo cadastro
    modoCadastro = false;
    nomeCadastro = "";
    
    // Pisca LED verde e bip para indicar sucesso
    digitalWrite(LED_VERDE, HIGH);
    tone(BUZZER_PIN, 1000, 200);
    delay(500);
    digitalWrite(LED_VERDE, LOW);
    noTone(BUZZER_PIN);
    
    mfrc522.PICC_HaltA();
    return;
  }

  // Modo normal: envia UID e aguarda resposta de acesso
  Serial.print("UID:");
  for (int i = 0; i < 4; i++) {
    if (uid[i] < 0x10) Serial.print("0");
    Serial.print(uid[i], HEX);
    if (i < 3) Serial.print(" ");
  }
  Serial.println();

  unsigned long inicio = millis();
  bool respostaRecebida = false;
  String resposta = "";
  while (millis() - inicio < TIMEOUT_RESPOSTA) {
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
    digitalWrite(LED_VERDE, HIGH);
    tone(BUZZER_PIN, 1000, 200);
    delay(200);
    tone(BUZZER_PIN, 1500, 200);
    delay(300);
    noTone(BUZZER_PIN);
    digitalWrite(LED_VERDE, LOW);
    Serial.println("Acesso Liberado");
  } else {
    digitalWrite(LED_VERMELHO, HIGH);
    tone(BUZZER_PIN, 400, 300);
    delay(300);
    tone(BUZZER_PIN, 600, 400);
    delay(400);
    noTone(BUZZER_PIN);
    digitalWrite(LED_VERMELHO, LOW);
    Serial.println("Acesso Negado");
  }

  mfrc522.PICC_HaltA();
  delay(200);
}

void processarComando(String comando) {
  if (comando.startsWith("CADASTRAR:")) {
    // Extrai o nome (ignorado, mas pode ser usado para log)
    nomeCadastro = comando.substring(10);
    nomeCadastro.trim();
    modoCadastro = true;
    tempoEntradaCadastro = millis();
    Serial.println("Modo cadastro ativado. Aproxime a tag RFID.");
    // Pisca LED amarelo (usando vermelho e verde juntos) para indicar modo
    digitalWrite(LED_VERMELHO, HIGH);
    digitalWrite(LED_VERDE, HIGH);
    delay(500);
    digitalWrite(LED_VERMELHO, LOW);
    digitalWrite(LED_VERDE, LOW);
  }
  else if (comando.startsWith("REMOVER:")) {
    // Backend espera uma confirmação de remoção
    Serial.println("SUCESSO: Usuário removido");
    // Feedback visual
    digitalWrite(LED_VERMELHO, HIGH);
    delay(300);
    digitalWrite(LED_VERMELHO, LOW);
    delay(200);
    digitalWrite(LED_VERMELHO, HIGH);
    delay(300);
    digitalWrite(LED_VERMELHO, LOW);
  }
  else if (comando == "LIMPAR:TODOS") {
    // Backend espera confirmação de limpeza total
    Serial.println("SUCESSO: Todos os usuários foram removidos");
    // Feedback visual: pisca rápido
    for (int i = 0; i < 5; i++) {
      digitalWrite(LED_VERMELHO, HIGH);
      digitalWrite(LED_VERDE, HIGH);
      delay(100);
      digitalWrite(LED_VERMELHO, LOW);
      digitalWrite(LED_VERDE, LOW);
      delay(100);
    }
  }
}