// src/utils/whatsappHelpers.js
function formatarNumeroWhatsApp(numero) {
  if (!numero) return null;
  let cleaned = numero.replace(/\D/g, '');
  if (!cleaned.startsWith('55')) cleaned = '55' + cleaned;
  if (cleaned.length === 13 || cleaned.length === 12) return cleaned;
  console.warn(`[WHATSAPP] Número inválido: ${numero} -> ${cleaned}`);
  return null;
}

const mensagensProntas = {
  entrada: (nome, hora) => 
    `🚪 *Entrada Registrada*\n\nSeu filho(a) *${nome}* entrou na escola às *${hora}*. ✅`,

  reentrada: (nome, hora) => 
    `🔄 *Reentrada Registrada*\n\nSeu filho(a) *${nome}* reentrou na escola às *${hora}*. ✅`,

  saida: (nome, hora) => 
    `🏠 *Saída Registrada*\n\nSeu filho(a) *${nome}* saiu da escola às *${hora}*. ✅`,

  atraso: (nome, hora, motivo, autorizadoPor) => 
    `⏰ *Entrada Atrasada*\n\nSeu filho(a) *${nome}* chegou atrasado às *${hora}*.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}`,

  saidaJustificada: (nome, hora, motivo, autorizadoPor) => 
    `⚠️ *Saída Justificada*\n\nSeu filho(a) *${nome}* saiu da escola às *${hora}*.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}`,

  // 🆕 Saída pela liberação da gestão (quando passa o cartão e sai)
  saidaLiberada: (nome, hora, motivo, autorizadoPor) =>
    `🔓 *Saída Liberada*\n\nSeu filho(a) *${nome}* saiu da escola às *${hora}* mediante liberação da gestão.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}`,

  // 🆕 Aviso de liberação individual (enviado no momento da liberação pela gestão)
  liberacaoIndividual: (nome, motivo, autorizadoPor, horario) =>
    horario
      ? `🔔 *Liberação Agendada*\n\nSeu filho(a) *${nome}* foi liberado(a) para sair às *${horario}*.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}\n\nAguarde o horário para buscá-lo(a), se necessário.`
      : `🔔 *Liberação de Acesso*\n\nSeu filho(a) *${nome}* foi liberado(a) para saída antecipada.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}`,

  // 🆕 Aviso de liberação de turma ou escola toda
  liberacaoTurma: (nome, turma, motivo, autorizadoPor, horario) =>
    horario
      ? `🏫 *Liberação de Turma*\n\nA turma do(a) seu filho(a) *${nome}* (${turma}) foi liberada às *${horario}*.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}\n\nCaso necessário, compareça para buscá-lo(a).`
      : `🏫 *Liberação de Turma*\n\nA turma do(a) seu filho(a) *${nome}* (${turma}) foi liberada.\n📝 Motivo: ${motivo}\n👤 Autorizado por: ${autorizadoPor}`,

  cadastro: (resp, login, senha, link) => 
    `🎉 *Acesso ao Portal*\n\nOlá ${resp}, acesso criado.\n🔑 Login: ${login}\n🔒 Senha: ${senha}\n🔗 ${link}\n\nAcompanhe presenças e receba notificações.`,

  instrucoes: () => 
    `📱 *SmartPass*\n\nUse o portal dos pais para acompanhar seu filho.`
};

module.exports = { formatarNumeroWhatsApp, mensagensProntas };