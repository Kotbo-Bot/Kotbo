/** Modules fun. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

import { m } from '../i18n';
// Fun API functions
export async function fetchFunConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun', { method: 'GET', guildId, errorContext: 'API Error (Fetch Fun Config):' });
}

export async function updateFunConfig(config, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun', { method: 'PATCH', successMessage: m.api_ok_update_fun_config(), payload: config, guildId, errorContext: 'API Error (Update Fun Config):' });
}

export async function fetchConfessions(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/confessions', { method: 'GET', guildId, errorContext: 'API Error (Fetch Confessions):' });
}

export async function resetCountingGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/counting/reset', { method: 'POST', successMessage: m.api_ok_reset_counting_game(), guildId, errorContext: 'API Error (Reset Counting):' });
}

export async function resetGuessNumberGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/guess-number/reset', { method: 'POST', successMessage: m.api_ok_reset_guess_number_game(), guildId, errorContext: 'API Error (Reset Guess Number):' });
}

export async function resetWordChainGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/word-chain/reset', { method: 'POST', successMessage: m.api_ok_reset_word_chain_game(), guildId, errorContext: 'API Error (Reset Word Chain):' });
}

export async function resetEmojiRiddleGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/emoji-riddle/reset', { method: 'POST', successMessage: m.api_ok_reset_emoji_riddle_game(), guildId, errorContext: 'API Error (Reset Emoji Riddle):' });
}

export async function fetchEmojiRiddles(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/emoji-riddles', { method: 'GET', guildId, errorContext: 'API Error (Fetch Emoji Riddles):' });
}

export async function createEmojiRiddle(riddle: { emojis: string; answers: string[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/emoji-riddles', { method: 'POST', successMessage: m.api_ok_create_emoji_riddle(), payload: riddle, guildId, errorContext: 'API Error (Create Emoji Riddle):' });
}

export async function updateEmojiRiddle(id: string, riddle: { emojis: string; answers: string[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/fun/emoji-riddles/${encodeURIComponent(id)}`, { method: 'PATCH', successMessage: m.api_ok_update_emoji_riddle(), payload: riddle, guildId, errorContext: 'API Error (Update Emoji Riddle):' });
}

export async function deleteEmojiRiddle(id: string, guildId = authStore.selectedGuildId, { silent = false }: { silent?: boolean } = {}) {
  return dashboardRequest(`/fun/emoji-riddles/${encodeURIComponent(id)}`, { method: 'DELETE', successMessage: m.api_ok_delete_emoji_riddle(), guildId, silent, errorContext: 'API Error (Delete Emoji Riddle):' });
}
