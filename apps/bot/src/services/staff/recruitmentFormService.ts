import { createHash, randomBytes } from 'node:crypto';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { assertFreeQuota } from '../system/freeQuota.js';
import { countRecruitmentForms } from '../features/customFormService.js';

// ============================================================================
// API KEY GENERATION
// ============================================================================

interface CreateAPIKeyResult {
  apiKey: string;
  displayKey: string;
  keyHash: string;
}

export function generateAPIKey(): CreateAPIKeyResult {
  // Generate a 32-byte (256-bit) random key
  const rawKey = randomBytes(32).toString('hex');
  
  // Create display key (first 4 + last 4 chars)
  const displayKey = `${rawKey.slice(0, 4)}...${rawKey.slice(-4)}`;
  
  // Create SHA256 hash for storage
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  
  return {
    apiKey: rawKey,
    displayKey,
    keyHash,
  };
}

export async function createRecruitmentAPIKey(
  guildId: string,
  createdByUserId: string,
  name: string = 'Recruitment Form API Key'
): Promise<{ id: string; apiKey: string; displayKey: string }> {
  const { apiKey, displayKey, keyHash } = generateAPIKey();

  const record = await prisma.aPIKey.create({
    data: {
      guildId,
      createdByUserId,
      keyHash,
      displayKey,
      name,
      permissions: ['recruitment:submit', 'recruitment:webhook'],
      isActive: true,
    },
  });

  logger.success('RecruitmentForm', `API Key created for guild ${guildId}: ${displayKey}`);

  return { id: record.id, apiKey, displayKey };
}

export async function verifyAPIKey(apiKey: string, guildId: string): Promise<boolean> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  
  const keyRecord = await prisma.aPIKey.findFirst({
    where: {
      keyHash,
      guildId,
      isActive: true,
    },
  });
  
  if (!keyRecord) return false;
  
  // Update last used timestamp
  await prisma.aPIKey.update({
    where: { id: keyRecord.id },
    data: { lastUsedAt: new Date() },
  });
  
  return true;
}

// ============================================================================
// FORM STRUCTURE TYPES
// ============================================================================

export type FormFieldType = 
  | 'short_text'
  | 'paragraph'
  | 'multiple_choice'
  | 'checkboxes'
  | 'dropdown'
  | 'email'
  | 'number'
  | 'date';

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  description?: string;
  required: boolean;
  options?: string[]; // For multiple_choice, checkboxes, dropdown
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface FormStructure {
  title: string;
  description?: string;
  type?: 'google' | 'default' | 'simple' | 'custom';
  fields: FormField[];
}

// ============================================================================
// FORM MANAGEMENT
// ============================================================================

export async function createRecruitmentForm(
  guildId: string,
  createdByUserId: string,
  name: string,
  description: string | undefined,
  structure: FormStructure
) {
  await assertFreeQuota(guildId, 'recruitmentForms', () => countRecruitmentForms(guildId));

  let apiKeyId: string | null = null;
  let apiKey: string | null = null;
  let displayKey: string | null = null;

  // Only create API key for Google Forms integration
  if (structure.type === 'google') {
    const keyResult = await createRecruitmentAPIKey(
      guildId,
      createdByUserId,
      `API Key for ${name}`
    );
    apiKeyId = keyResult.id;
    apiKey = keyResult.apiKey;
    displayKey = keyResult.displayKey;
  }

  // Create the form
  const form = await prisma.recruitmentForm.create({
    data: {
      guildId,
      name,
      description,
      structure: structure as unknown as Parameters<typeof prisma.recruitmentForm.create>[0]['data']['structure'],
      apiKeyId,
      isActive: true,
      submissionsCount: 0,
    },
  });

  logger.success('RecruitmentForm', `Form created: ${name} for guild ${guildId}`);

  return { form, apiKey, displayKey };
}

export async function getRecruitmentForms(guildId: string) {
  const forms = await prisma.recruitmentForm.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: {
          candidatures: true,
        },
      },
    },
  });

  // Une seule requête pour toutes les clés au lieu d'un N+1 par formulaire.
  const keyIds = forms.flatMap((form) => form.apiKeyId ? [form.apiKeyId] : []);
  const apiKeys = keyIds.length
    ? await prisma.aPIKey.findMany({
        where: { id: { in: keyIds } },
        select: { id: true, displayKey: true, isActive: true, lastUsedAt: true },
      })
    : [];
  const keysById = new Map(apiKeys.map((key) => [key.id, key]));
  const formsWithKeys = forms.map((form) => ({
    ...form,
    apiKey: form.apiKeyId ? keysById.get(form.apiKeyId) ?? null : null,
  }));

  return formsWithKeys;
}

export async function getRecruitmentForm(formId: string, guildId: string) {
  const form = await prisma.recruitmentForm.findFirst({
    where: { id: formId, guildId },
  });

  if (!form) return null;

  // Fetch API key separately
  let apiKey = null;
  if (form.apiKeyId) {
    apiKey = await prisma.aPIKey.findUnique({
      where: { id: form.apiKeyId },
    });
  }

  return {
    ...form,
    apiKey,
  };
}

export async function updateRecruitmentForm(
  formId: string,
  guildId: string,
  updates: {
    name?: string;
    description?: string;
    structure?: FormStructure;
    isActive?: boolean;
  }
) {
  const { structure, ...rest } = updates;
  return await prisma.recruitmentForm.updateMany({
    where: { id: formId, guildId },
    data: {
      ...rest,
      ...(structure !== undefined && {
        structure: structure as unknown as Parameters<typeof prisma.recruitmentForm.create>[0]['data']['structure'],
      }),
    },
  });
}

export async function deleteRecruitmentForm(formId: string, guildId: string) {
  // Get the form to find the API key
  const form = await prisma.recruitmentForm.findFirst({
    where: { id: formId, guildId },
  });
  
  // Delete associated API key
  if (form?.apiKeyId) {
    await prisma.aPIKey.delete({
      where: { id: form.apiKeyId },
    });
  }
  
  // Delete the form
  await prisma.recruitmentForm.deleteMany({
    where: { id: formId, guildId },
  });
  
  logger.success('RecruitmentForm', `Form deleted: ${formId}`);
}

export async function regenerateFormAPIKey(formId: string, guildId: string, createdByUserId: string) {
  const form = await prisma.recruitmentForm.findFirst({
    where: { id: formId, guildId },
  });

  if (!form) {
    throw new Error('Form not found');
  }

  const structure = form.structure as unknown as FormStructure;
  if (structure?.type !== 'google') {
    throw new Error('La régénération de clé API est réservée aux formulaires Google Forms.');
  }

  // Delete old API key - use deleteMany so it doesn't throw if already gone
  if (form.apiKeyId) {
    await prisma.aPIKey.deleteMany({
      where: { id: form.apiKeyId },
    });
    // Clear the stale reference before creating the new key
    await prisma.recruitmentForm.update({
      where: { id: formId },
      data: { apiKeyId: null },
    });
  }

  // Create new API key - returns record id directly, no extra lookup needed
  const { id: newApiKeyId, apiKey, displayKey } = await createRecruitmentAPIKey(
    guildId,
    createdByUserId,
    `API Key for ${form.name}`
  );

  // Link the new key to the form
  await prisma.recruitmentForm.update({
    where: { id: formId },
    data: { apiKeyId: newApiKeyId },
  });

  logger.success('RecruitmentForm', `API Key regenerated for form ${formId}`);

  return { apiKey, displayKey };
}


// ============================================================================
// GOOGLE APPS SCRIPT GENERATOR
// ============================================================================

export function generateGoogleAppsScript(
  webhookUrl: string,
  apiKey: string,
  formTitle: string,
  guildId: string
): string {
  return `// ============================================================================
// GOOGLE APPS SCRIPT FOR KOTBO RECRUITMENT FORM
// ============================================================================
// This script sends form submissions to your Kotbo bot webhook
// Form: ${formTitle}
// ============================================================================

function onSubmit(e) {
  try {
    // Get the form response
    var formResponse = e.response;
    var itemResponses = formResponse.getItemResponses();
    
    // Build the data object
    var data = {
      timestamp: new Date().toISOString(),
      data: {}
    };
    
    // Extract all form fields
    for (var i = 0; i < itemResponses.length; i++) {
      var itemResponse = itemResponses[i];
      var question = itemResponse.getItem().getTitle();
      var answer = itemResponse.getResponse();
      
      // Handle different response types
      if (Array.isArray(answer)) {
        data.data[question] = answer;
      } else {
        data.data[question] = answer || '';
      }
    }
    
    // Send to Kotbo webhook
    var options = {
      'method': 'post',
      'contentType': 'application/json',
      'headers': {
        'Authorization': 'Bearer ${apiKey}',
        'X-Kotbo-Guild-ID': '${guildId}'
      },
      'payload': JSON.stringify(data),
      'muteHttpExceptions': true
    };
    
    var response = UrlFetchApp.fetch('${webhookUrl}', options);
    var responseCode = response.getResponseCode();
    
    if (responseCode === 201 || responseCode === 200) {
      Logger.log('✅ Form submission sent successfully to Kotbo');
    } else {
      Logger.log('❌ Failed to send form submission. Status: ' + responseCode);
      Logger.log('Response: ' + response.getContentText());
    }
    
  } catch (error) {
    Logger.log('❌ Error in onSubmit: ' + error.toString());
  }
}

// ============================================================================
// SETUP INSTRUCTIONS
// ============================================================================
// 1. Open your Google Form
// 2. Click on "Extensions" > "Apps Script"
// 3. Delete any existing code
// 4. Paste this entire script
// 5. Save the project (Ctrl+S or Cmd+S)
// 6. Click on the clock icon (Triggers) in the left sidebar
// 7. Click "+ Add Trigger"
// 8. Configure:
//    - Choose which function to run: onSubmit
//    - Select event source: From form
//    - Select event type: On form submit
// 9. Click "Save" and authorize the script
// 10. Test your form!
// ============================================================================
`;
}

// ============================================================================
// FORM TEMPLATE GENERATORS
// ============================================================================

export function generateDefaultRecruitmentForm(): FormStructure {
  return {
    title: 'Candidature Staff',
    description: 'Merci de votre intérêt pour rejoindre notre équipe !',
    fields: [
      {
        id: 'discord_username',
        type: 'short_text',
        label: 'Pseudo Discord',
        description: 'Votre pseudo exact sur Discord (ex: User#1234)',
        required: true,
      },
      {
        id: 'discord_id',
        type: 'short_text',
        label: 'ID Discord',
        description: "Votre ID Discord numérique (clic droit sur votre profil > Copier l'ID)",
        required: true,
        validation: {
          pattern: '^\\d{17,19}$',
        },
      },
      {
        id: 'age',
        type: 'number',
        label: 'Âge',
        description: 'Votre âge en années',
        required: true,
        validation: {
          min: 13,
          max: 100,
        },
      },
      {
        id: 'email',
        type: 'email',
        label: 'Email',
        description: 'Une adresse email valide pour vous contacter',
        required: true,
      },
      {
        id: 'timezone',
        type: 'dropdown',
        label: 'Fuseau horaire',
        description: 'Votre fuseau horaire principal',
        required: true,
        options: [
          'UTC-12',
          'UTC-11',
          'UTC-10',
          'UTC-9',
          'UTC-8',
          'UTC-7',
          'UTC-6',
          'UTC-5',
          'UTC-4',
          'UTC-3',
          'UTC-2',
          'UTC-1',
          'UTC+0',
          'UTC+1',
          'UTC+2',
          'UTC+3',
          'UTC+4',
          'UTC+5',
          'UTC+6',
          'UTC+7',
          'UTC+8',
          'UTC+9',
          'UTC+10',
          'UTC+11',
          'UTC+12',
        ],
      },
      {
        id: 'availability',
        type: 'paragraph',
        label: 'Disponibilités',
        description: 'Quels jours et horaires êtes-vous disponible pour la modération ?',
        required: true,
      },
      {
        id: 'experience',
        type: 'paragraph',
        label: 'Expérience de modération',
        description: 'Décrivez votre expérience précédente en modération (serveurs, rôles, responsabilités)',
        required: true,
      },
      {
        id: 'motivation',
        type: 'paragraph',
        label: 'Motivation',
        description: "Pourquoi voulez-vous rejoindre notre équipe ? Qu'est-ce qui vous motive à devenir modérateur ?",
        required: true,
      },
      {
        id: 'microphone',
        type: 'multiple_choice',
        label: 'Microphone',
        description: 'Avez-vous un microphone fonctionnel pour les entretiens vocaux ?',
        required: true,
        options: ['Oui', 'Non'],
      },
      {
        id: 'additional_info',
        type: 'paragraph',
        label: 'Informations supplémentaires',
        description: 'Toute autre information que vous souhaitez partager (optionnel)',
        required: false,
      },
    ],
  };
}

export function generateSimpleRecruitmentForm(): FormStructure {
  return {
    title: 'Candidature Simplifiée',
    description: 'Formulaire de candidature rapide',
    fields: [
      {
        id: 'discord_username',
        type: 'short_text',
        label: 'Pseudo Discord',
        required: true,
      },
      {
        id: 'discord_id',
        type: 'short_text',
        label: 'ID Discord',
        required: true,
      },
      {
        id: 'age',
        type: 'number',
        label: 'Âge',
        required: true,
      },
      {
        id: 'motivation',
        type: 'paragraph',
        label: 'Motivation',
        required: true,
      },
    ],
  };
}
