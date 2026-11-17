// Only a configured Discord user ID produces a ping. Never allow an error
// message or wallet input to choose who is mentioned.
export async function notifyAdminFailure(thread, wallet, detail) {
  const adminId = process.env.DISCORD_ADMIN_ID?.trim();
  const ping = adminId && /^\d{17,20}$/.test(adminId);
  return thread.send({
    content: `${ping ? `<@${adminId}>` : '@en'} 錢包 ${wallet} ${detail}，請協助查核。`,
    allowedMentions: { users: ping ? [adminId] : [] },
  });
}
