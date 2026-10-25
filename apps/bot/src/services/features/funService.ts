import { Client, Message } from 'discord.js';
import { kotboEventBus, type FunGameKey } from '@kotbo/core';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { recordCountingMistake, recordCountingSuccess, scheduleCountingStatus } from './countingStatsService.js';

/**
 * Gets or creates the Fun Game State for a guild.
 */
export async function getOrCreateFunGameState(guildId: string) {
  let state = await prisma.funGameState.findUnique({
    where: { guildId }
  });

  if (!state) {
    state = await prisma.funGameState.create({
      data: {
        guildId,
        countingCurrent: 0,
        countingLastUserId: null,
        oneWordStoryLastUserId: null,
        guessNumberTarget: Math.floor(Math.random() * 1000) + 1
      }
    });
  }

  return state;
}

/**
 * Resets the counting game.
 */
export async function resetCounting(guildId: string) {
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      countingCurrent: 0,
      countingLastUserId: null,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1
    },
    update: {
      countingCurrent: 0,
      countingLastUserId: null
    }
  });
}

/**
 * Resets the guess the number game with a new target.
 */
export async function resetGuessNumber(guildId: string) {
  const newTarget = Math.floor(Math.random() * 1000) + 1;
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      countingCurrent: 0,
      guessNumberTarget: newTarget
    },
    update: {
      guessNumberTarget: newTarget
    }
  });
}

/**
 * Avertit d'une erreur sans réinitialiser l'état du jeu : supprime le message
 * fautif et prévient son auteur, le temps que quelqu'un d'autre reprenne
 * correctement. Utilisé quand le mode punitif est désactivé.
 */
async function warnMistakeWithoutReset(message: Message, text: string) {
  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(text).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 4000);
  }
}

/**
 * Handles messages in the Counting channel.
 *
 * `punitiveMode` détermine ce qui arrive à une erreur : reset complet du
 * comptage (comportement historique), ou simple suppression du message avec
 * avertissement, la progression étant préservée.
 */
export async function handleCountingMessage(message: Message, guildId: string, punitiveMode: boolean) {
  const content = message.content.trim();

  // Only process if the message is exactly a number
  if (!/^\d+$/.test(content)) {
    return;
  }

  const num = parseInt(content, 10);
  const gameState = await getOrCreateFunGameState(guildId);
  const nextNumber = gameState.countingCurrent + 1;

  // Rule 1: Incorrect number resets the game
  if (num !== nextNumber) {
    await recordCountingMistake(guildId, message.author.id);
    scheduleCountingStatus(message.client, guildId, message.channelId);
    if (punitiveMode) {
      await resetCounting(guildId);
      await message.react('❌').catch(() => null);
      await message.reply(`❌ **Chiffre incorrect !** ${message.author} a ruiné le comptage à **${gameState.countingCurrent}**. On recommence à 0 !`).catch(() => null);
    } else {
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! Le prochain nombre est **${nextNumber}**.`);
    }
    return;
  }

  // Rule 2: Same user cannot count twice in a row
  if (gameState.countingLastUserId === message.author.id) {
    await recordCountingMistake(guildId, message.author.id);
    scheduleCountingStatus(message.client, guildId, message.channelId);
    if (punitiveMode) {
      await resetCounting(guildId);
      await message.react('❌').catch(() => null);
      await message.reply(`❌ **Double comptage !** Vous ne pouvez pas compter deux fois de suite. Le comptage est réinitialisé à 0 !`).catch(() => null);
    } else {
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! Tu ne peux pas compter deux fois de suite. Le prochain nombre reste **${nextNumber}**.`);
    }
    return;
  }

  // Correct count! Update state
  // Conditionné sur la valeur lue : de deux « 42 » postés en même temps, un seul avance le compteur.
  const { count: advanced } = await prisma.funGameState.updateMany({
    where: { guildId, countingCurrent: gameState.countingCurrent },
    data: {
      countingCurrent: nextNumber,
      countingLastUserId: message.author.id,
      countingUpdatedAt: new Date()
    }
  });

  if (advanced === 0) {
    await warnMistakeWithoutReset(message, `❌ ${message.author}, quelqu'un a été plus rapide ! Le comptage continue sans toi.`);
    return;
  }

  await recordCountingSuccess(guildId, message.author.id, nextNumber);
  scheduleCountingStatus(message.client, guildId, message.channelId);
  await message.react('✅').catch(() => null);

  // Celebratory milestones
  if (nextNumber % 100 === 0) {
    await message.react('🎉').catch(() => null);
    await message.react('💯').catch(() => null);
    if (!message.channel.isSendable()) {
      return;
    }
    await message.channel.send(`🎉 **Palier exceptionnel !** Nous avons atteint **${nextNumber}** ! Bravo à tous ! 👑`).catch(() => null);
  } else if (nextNumber % 10 === 0) {
    await message.react('⭐').catch(() => null);
  }
}

/**
 * Handles messages in the One Word Story channel.
 */
export async function handleOneWordStoryMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  
  if (!content) return;

  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const gameState = await getOrCreateFunGameState(guildId);

  // Validate: exactly one word AND user is not the same as the last one
  const isInvalid = wordCount !== 1 || gameState.oneWordStoryLastUserId === message.author.id;

  if (isInvalid) {
    await message.delete().catch(() => null);
    if (!message.channel.isSendable()) {
      return;
    }
    const warnMsg = await message.channel.send(`❌ ${message.author}, un seul mot à la fois et vous ne pouvez pas jouer deux fois de suite !`).catch(() => null);
    if (warnMsg) {
      setTimeout(() => {
        warnMsg.delete().catch(() => null);
      }, 3000);
    }
    return;
  }

  // Valid word! Update last user
  await prisma.funGameState.update({
    where: { guildId },
    data: {
      oneWordStoryLastUserId: message.author.id
    }
  });
}

/**
 * Signale une victoire aux automatisations. Ne lève jamais : un abonné en échec
 * ne doit pas priver le gagnant de sa réponse dans le salon.
 */
function publishGameWon(message: Message, guildId: string, game: FunGameKey, answer: string) {
  try {
    kotboEventBus.publish('fun:game-won', {
      guildId,
      game,
      userId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
      content: message.content,
      answer,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('Fun', `Publication de la victoire (${game}) impossible pour ${guildId} :`, err);
  }
}

/**
 * Handles messages in the Guess the Number channel.
 */
export async function handleGuessNumberMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  
  if (!/^\d+$/.test(content)) {
    return;
  }

  const guess = parseInt(content, 10);
  const gameState = await getOrCreateFunGameState(guildId);
  const target = gameState.guessNumberTarget;

  if (guess < target) {
    await message.react('⬆️').catch(() => null);
  } else if (guess > target) {
    await message.react('⬇️').catch(() => null);
  } else {
    // Winner! Generate new target
    const newTarget = Math.floor(Math.random() * 1000) + 1;
    await prisma.funGameState.update({
      where: { guildId },
      data: {
        guessNumberTarget: newTarget
      }
    });

    await message.react('🎉').catch(() => null);
    await message.reply(`🎉 **Félicitations ${message.author} !** Tu as deviné le nombre mystère qui était **${target}** ! Un nouveau nombre mystère a été généré (entre 1 et 1000).`).catch(() => null);
    publishGameWon(message, guildId, 'guess_number', String(target));
  }
}

// Commence et finit par une lettre : un tiret final imposerait « - » comme
// initiale du mot suivant.
const WORD_CHAIN_WORD_PATTERN = /^[a-zA-ZÀ-ÖØ-öø-ÿœŒæÆ][a-zA-ZÀ-ÖØ-öø-ÿœŒæÆ-]*[a-zA-ZÀ-ÖØ-öø-ÿœŒæÆ]$/;

// NFD ne décompose pas les ligatures : sans ce remplacement, « œuvre » ne
// pourrait jamais suivre un mot finissant par « o ».
function stripAccents(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE');
}

/**
 * Resets the word chain game.
 */
export async function resetWordChain(guildId: string) {
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1,
      wordChainLastWord: null,
      wordChainLastUserId: null
    },
    update: {
      wordChainLastWord: null,
      wordChainLastUserId: null
    }
  });
}

/**
 * Handles messages in the Word Chain channel : chaque mot doit commencer par
 * la dernière lettre du précédent, posé par quelqu'un d'autre.
 *
 * `punitiveMode` détermine ce qui arrive à une erreur, comme pour le comptage.
 */
export async function handleWordChainMessage(message: Message, guildId: string, punitiveMode: boolean) {
  const content = message.content.trim();

  // Seuls les messages d'un seul mot alphabétique participent au jeu - le
  // reste (discussion) est laissé tranquille, comme pour le comptage.
  if (!WORD_CHAIN_WORD_PATTERN.test(content)) {
    return;
  }

  const gameState = await getOrCreateFunGameState(guildId);
  const normalized = stripAccents(content).toLowerCase();
  const lastWord = gameState.wordChainLastWord ? stripAccents(gameState.wordChainLastWord).toLowerCase() : null;
  const requiredLetter = lastWord ? lastWord[lastWord.length - 1] : null;

  const sameUserTwice = gameState.wordChainLastUserId === message.author.id;
  const wrongLetter = requiredLetter !== null && normalized[0] !== requiredLetter;

  if (sameUserTwice || wrongLetter) {
    if (punitiveMode) {
      await resetWordChain(guildId);
      await message.react('❌').catch(() => null);
      const reason = sameUserTwice
        ? 'vous ne pouvez pas jouer deux fois de suite'
        : `le mot devait commencer par « ${requiredLetter?.toUpperCase()} »`;
      await message.reply(`❌ **Chaîne brisée !** ${message.author}, ${reason}. On recommence !`).catch(() => null);
    } else {
      const reason = sameUserTwice
        ? 'tu ne peux pas jouer deux fois de suite'
        : `le mot devait commencer par « ${requiredLetter?.toUpperCase()} »`;
      await warnMistakeWithoutReset(message, `❌ ${message.author}, tu t'es trompé ! ${reason}.`);
    }
    return;
  }

  await prisma.funGameState.update({
    where: { guildId },
    data: {
      wordChainLastWord: content,
      wordChainLastUserId: message.author.id
    }
  });

  await message.react('✅').catch(() => null);
}

/**
 * Rébus fournis avec Kotbo : ils font tourner le jeu sans aucune saisie, et
 * s'ajoutent à ceux du staff tant que `funEmojiRiddleUseDefaults` est actif.
 */
export const DEFAULT_EMOJI_RIDDLES: { emojis: string; answers: string[] }[] = [
  { emojis: '🦁👑', answers: ['le roi lion', 'roi lion'] },
  { emojis: '🕷️👨', answers: ['spider-man', 'spiderman'] },
  { emojis: '🧊👸❄️', answers: ['la reine des neiges', 'reine des neiges', 'frozen'] },
  { emojis: '🦇👨', answers: ['batman'] },
  { emojis: '🍫🏭', answers: ['charlie et la chocolaterie'] },
  { emojis: '👽📞🏠', answers: ['et', 'e.t.'] },
  { emojis: '🧙‍♂️💍', answers: ['le seigneur des anneaux', 'seigneur des anneaux'] },
  { emojis: '🐉🎂', answers: ['shrek'] },
  { emojis: '🚢🧊💔', answers: ['titanic'] },
  { emojis: '👨‍🚀🌾🥔', answers: ['seul sur mars'] },
  { emojis: '🐟🔍', answers: ['le monde de nemo', 'nemo'] },
  { emojis: '🦖🏝️', answers: ['jurassic park'] },
];

// Lettres de toutes les écritures : un rébus du staff peut attendre une
// réponse en cyrillique ou en japonais, qu'un filtre a-z viderait.
export function normalizeAnswer(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tire un rébus parmi ceux du staff et, si le serveur le garde, ceux fournis.
 * Le rébus en cours est écarté quand il reste un autre choix : sinon la bonne
 * réponse qu'on vient de donner resservirait aussitôt.
 */
async function pickEmojiRiddle(guildId: string, currentEmojis: string | null): Promise<{ emojis: string; answers: string[] }> {
  const [guild, custom] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: { funEmojiRiddleUseDefaults: true } }),
    prisma.funEmojiRiddle.findMany({ where: { guildId }, select: { emojis: true, answers: true } }),
  ]);

  let pool = custom.filter((r) => r.answers.length > 0);
  if (guild?.funEmojiRiddleUseDefaults !== false || pool.length === 0) {
    pool = [...pool, ...DEFAULT_EMOJI_RIDDLES];
  }

  const others = pool.filter((r) => r.emojis !== currentEmojis);
  const candidates = others.length > 0 ? others : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Génère un nouveau rébus emoji.
 */
export async function resetEmojiRiddle(guildId: string) {
  const current = await prisma.funGameState.findUnique({ where: { guildId }, select: { emojiRiddleEmojis: true } });
  const riddle = await pickEmojiRiddle(guildId, current?.emojiRiddleEmojis ?? null);
  return prisma.funGameState.upsert({
    where: { guildId },
    create: {
      guildId,
      guessNumberTarget: Math.floor(Math.random() * 1000) + 1,
      emojiRiddleEmojis: riddle.emojis,
      emojiRiddleAnswer: JSON.stringify(riddle.answers)
    },
    update: {
      emojiRiddleEmojis: riddle.emojis,
      emojiRiddleAnswer: JSON.stringify(riddle.answers)
    }
  });
}

/**
 * Publie le rébus en cours dans son salon : l'indice n'est stocké qu'en base,
 * les joueurs ne le voient que par ce message.
 */
export async function announceEmojiRiddle(client: Client, channelId: string, emojis: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return;
  await channel.send(`🧩 **Nouveau rébus !** Quelle expression se cache derrière ${emojis} ?`).catch(() => null);
}

/**
 * Handles messages in the Emoji Riddle channel. Sans pénalité en cas
 * d'erreur : on laisse le salon deviner librement, comme pour le nombre
 * mystère.
 */
export async function handleEmojiRiddleMessage(message: Message, guildId: string) {
  const content = message.content.trim();
  if (!content) return;

  let gameState = await getOrCreateFunGameState(guildId);
  if (!gameState.emojiRiddleEmojis || !gameState.emojiRiddleAnswer) {
    gameState = await resetEmojiRiddle(guildId);
    if (gameState.emojiRiddleEmojis) {
      await announceEmojiRiddle(message.client, message.channelId, gameState.emojiRiddleEmojis);
    }
    return;
  }

  let answers: string[];
  try {
    answers = JSON.parse(gameState.emojiRiddleAnswer ?? '[]');
  } catch {
    answers = [];
  }
  if (answers.length === 0) return;

  const guess = normalizeAnswer(content);
  const isCorrect = answers.some((a) => normalizeAnswer(a) === guess);
  if (!isCorrect) return;

  const previousClue = gameState.emojiRiddleEmojis;
  const nextState = await resetEmojiRiddle(guildId);
  await message.react('🎉').catch(() => null);
  await message.reply(`🎉 **Bravo ${message.author} !** Le rébus ${previousClue} voulait dire **${answers[0]}** ! Nouveau rébus : ${nextState.emojiRiddleEmojis}`).catch(() => null);
  publishGameWon(message, guildId, 'emoji_riddle', answers[0]);
}

const NEVER_SAY_PATTERN = /\b(oui|non)\b/i;

/**
 * Handles messages in the Never Say Yes/No channel : tout message contenant
 * « oui » ou « non » est supprimé, sans état à conserver.
 */
export async function handleNeverSayMessage(message: Message) {
  if (!NEVER_SAY_PATTERN.test(message.content)) return;

  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(`❌ ${message.author}, interdit de dire « oui » ou « non » ici !`).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 3000);
  }
}

// Au-delà d'Extended_Pictographic : emojis du serveur (<:nom:id>), teintes de
// peau, drapeaux (indicateurs régionaux, et balises pour l'Écosse ou le pays
// de Galles) et touches numérotées.
const CUSTOM_EMOJI = '<a?:\\w{2,32}:\\d{17,20}>';
const EMOJI_ONLY_PATTERN = new RegExp(
  `^(?:${CUSTOM_EMOJI}|\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[0-9#*]\\uFE0F?\\u20E3|[\\u{E0020}-\\u{E007F}]|\\u200D|\\uFE0F|\\s)+$`,
  'u',
);
const HAS_EMOJI_PATTERN = new RegExp(
  `${CUSTOM_EMOJI}|\\p{Extended_Pictographic}|\\p{Regional_Indicator}|\\u20E3`,
  'u',
);

/**
 * Handles messages in the Emoji Only channel : tout message contenant autre
 * chose que des emojis est supprimé.
 */
export async function handleEmojiOnlyMessage(message: Message) {
  const content = message.content;
  if (!content.trim()) return; // messages sans texte (pièces jointes...) laissés tranquilles

  if (EMOJI_ONLY_PATTERN.test(content) && HAS_EMOJI_PATTERN.test(content)) return;

  await message.delete().catch(() => null);
  if (!message.channel.isSendable()) return;
  const warnMsg = await message.channel.send(`❌ ${message.author}, seuls les emojis sont autorisés ici !`).catch(() => null);
  if (warnMsg) {
    setTimeout(() => {
      warnMsg.delete().catch(() => null);
    }, 3000);
  }
}
