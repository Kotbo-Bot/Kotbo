import fs from 'fs';
import path from 'path';

// Define the root of the bot source directory
const srcDir = path.resolve(__dirname, '../src');

// Commands categories mapping (relative to src/commands/)
const commandsMap: Record<string, string> = {
  'absent.ts': 'admin/absent.ts',
  'activate.ts': 'admin/activate.ts',
  'admin.ts': 'admin/admin.ts',
  'backup.ts': 'admin/backup.ts',
  'config.ts': 'admin/config.ts',
  'demission.ts': 'admin/demission.ts',
  'devutils.ts': 'admin/devutils.ts',
  'meeting.ts': 'admin/meeting.ts',
  'setup.ts': 'admin/setup.ts',
  'status.ts': 'admin/status.ts',
  
  'casier.ts': 'moderation/casier.ts',
  'channel.ts': 'moderation/channel.ts',
  'clear.ts': 'moderation/clear.ts',
  'dc.ts': 'moderation/dc.ts',
  'note.ts': 'moderation/note.ts',
  'rescan.ts': 'moderation/rescan.ts',
  'sanction.ts': 'moderation/sanction.ts',
  'signal.ts': 'moderation/signal.ts',
  'transcript.ts': 'moderation/transcript.ts',

  'epoch.ts': 'utility/epoch.ts',
  'event.ts': 'utility/event.ts',
  'help.ts': 'utility/help.ts',
  'info.ts': 'utility/info.ts',
  'invites.ts': 'utility/invites.ts',
  'ping.ts': 'utility/ping.ts',
  'post.ts': 'utility/post.ts',
  'serverstats.ts': 'utility/serverstats.ts',
  'stats.ts': 'utility/stats.ts',
  'suggest.ts': 'utility/suggest.ts',
  'suggestion-config.ts': 'utility/suggestion-config.ts',
  'ticket.ts': 'utility/ticket.ts',

  'ctf.ts': 'fun/ctf.ts',
  'excuse.ts': 'fun/excuse.ts',
  'giveaway.ts': 'fun/giveaway.ts',
  'say.ts': 'fun/say.ts',

  'leaderboard.ts': 'profile/leaderboard.ts',
  'profil.ts': 'profile/profil.ts',
  'profile.ts': 'profile/profile.ts',
  'rank.ts': 'profile/rank.ts',
};

// Services categories mapping (relative to src/services/)
const servicesMap: Record<string, string> = {
  'altAccountService.ts': 'moderation/altAccountService.ts',
  'autoModService.ts': 'moderation/autoModService.ts',
  'bannedWordsService.ts': 'moderation/bannedWordsService.ts',
  'codePoliceService.ts': 'moderation/codePoliceService.ts',
  'dcDetectionService.ts': 'moderation/dcDetectionService.ts',
  'memberCaseService.ts': 'moderation/memberCaseService.ts',
  'nicknameModerationService.ts': 'moderation/nicknameModerationService.ts',
  'sanctionService.ts': 'moderation/sanctionService.ts',

  'analyticsService.ts': 'analytics/analyticsService.ts',
  'dashboardAnalyticsService.ts': 'analytics/dashboardAnalyticsService.ts',
  'inviteService.ts': 'analytics/inviteService.ts',
  'messageScraperService.ts': 'analytics/messageScraperService.ts',
  'moduleStatsService.ts': 'analytics/moduleStatsService.ts',

  'autoBackupService.ts': 'system/autoBackupService.ts',
  'backupService.ts': 'system/backupService.ts',
  'databaseBackupService.ts': 'system/databaseBackupService.ts',
  'githubReleaseService.ts': 'system/githubReleaseService.ts',
  'restoreService.ts': 'system/restoreService.ts',

  'autoResponseService.ts': 'features/autoResponseService.ts',
  'eventService.ts': 'features/eventService.ts',
  'giveawayService.ts': 'features/giveawayService.ts',
  'reactionRoleService.ts': 'features/reactionRoleService.ts',
  'suggestionService.ts': 'features/suggestionService.ts',
  'ticketService.ts': 'features/ticketService.ts',
  'transcriptService.ts': 'features/transcriptService.ts',
  'welcomeGoodbyeService.ts': 'features/welcomeGoodbyeService.ts',

  'levelingService.ts': 'progression/levelingService.ts',
  'profileService.ts': 'progression/profileService.ts',

  'recruitmentService.ts': 'staff/recruitmentService.ts',
  'regulationService.ts': 'staff/regulationService.ts',
  'staffLeadershipService.ts': 'staff/staffLeadershipService.ts',
  'staffManagementService.ts': 'staff/staffManagementService.ts',

  'twitchService.ts': 'integrations/twitchService.ts',
  'youtubeService.ts': 'integrations/youtubeService.ts',
  'translationService.ts': 'integrations/translationService.ts',

  'dashboardManagementService.ts': 'core/dashboardManagementService.ts',
  'imageService.ts': 'core/imageService.ts',
  'presenceDetectionService.ts': 'core/presenceDetectionService.ts',
  'tutoringService.ts': 'core/tutoringService.ts',
  'newsService.ts': 'core/newsService.ts',
  'ctfTriggerService.ts': 'core/ctfTriggerService.ts',
};

// Build the global moved files map relative to src/
const movedFilesMap: Record<string, string> = {};

Object.entries(commandsMap).forEach(([file, newRelPath]) => {
  movedFilesMap[`commands/${file}`] = `commands/${newRelPath}`;
});

Object.entries(servicesMap).forEach(([file, newRelPath]) => {
  movedFilesMap[`services/${file}`] = `services/${newRelPath}`;
});

// Helper to find all files recursively
function getFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else if (file.endsWith('.ts')) {
      results.push(filePath);
    }
  });
  return results;
}

// Regex to capture import and export statements referencing relative files
const importExportRegex = /(from\s+['"](?:\.\.?\/[^'"]+)['"]|import\(\s*['"](?:\.\.?\/[^'"]+)['"]\s*\)|import\s+['"](?:\.\.?\/[^'"]+)['"])/g;

function migrateCodebase() {
  console.log('--- Starting Migration ---');

  // 1. First gather all typescript files currently in src
  const allFiles = getFilesRecursively(srcDir);
  console.log(`Found ${allFiles.length} TypeScript files in src/`);

  // We need to keep a map of file content and its old vs new relative path
  const fileStates: Array<{
    absoluteOldPath: string;
    absoluteNewPath: string;
    relativeOldPath: string; // e.g. "commands/ping.ts"
    relativeNewPath: string; // e.g. "commands/utility/ping.ts"
    content: string;
  }> = [];

  allFiles.forEach((absPath) => {
    const relOldPath = path.relative(srcDir, absPath).replace(/\\/g, '/');
    const relNewPath = movedFilesMap[relOldPath] || relOldPath;
    const absNewPath = path.join(srcDir, relNewPath);
    
    fileStates.push({
      absoluteOldPath: absPath,
      absoluteNewPath: absNewPath,
      relativeOldPath: relOldPath,
      relativeNewPath: relNewPath,
      content: fs.readFileSync(absPath, 'utf-8'),
    });
  });

  // 2. Rewrite imports in all file contents
  console.log('Updating relative imports...');
  fileStates.forEach((state) => {
    const oldContent = state.content;
    const newContent = oldContent.replace(importExportRegex, (match) => {
      const quoteMatch = match.match(/['"](\.\.?\/[^'"]+)['"]/);
      if (!quoteMatch) return match;
      const relImportPath = quoteMatch[1]; // e.g. "../services/altAccountService.js" or "./suggest.js"
      
      // Resolve the import target relative to the file's old path
      const oldDir = path.dirname(state.relativeOldPath);
      let targetRelPath = path.join(oldDir, relImportPath);
      targetRelPath = path.normalize(targetRelPath).replace(/\\/g, '/');

      // Check if it's pointing outside src/
      if (targetRelPath.startsWith('..')) {
        // Points outside src (like root package.json or config). No change.
        return match;
      }

      // Check if this target is a moved file
      const targetKey = targetRelPath.replace(/\.js$/, '.ts');
      let newTargetRelPath = targetRelPath;
      if (movedFilesMap[targetKey]) {
        newTargetRelPath = movedFilesMap[targetKey].replace(/\.ts$/, '.js');
      }

      // Calculate the new relative path from the new directory of the source file to the newTargetPath
      const newSourceDir = path.dirname(state.relativeNewPath);
      let newRelImport = path.relative(newSourceDir, newTargetRelPath);
      newRelImport = newRelImport.replace(/\\/g, '/');
      if (!newRelImport.startsWith('.')) {
        newRelImport = './' + newRelImport;
      }

      return match.replace(relImportPath, newRelImport);
    });

    state.content = newContent;
  });

  // 3. Move files on disk and write the updated contents
  console.log('Moving files and writing new content...');
  
  // Track files we should delete (ones that are moved to a different path)
  const filesToDelete: string[] = [];

  fileStates.forEach((state) => {
    if (state.absoluteOldPath !== state.absoluteNewPath) {
      filesToDelete.push(state.absoluteOldPath);
    }
    
    // Ensure the parent directory of the new path exists
    const newDir = path.dirname(state.absoluteNewPath);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    fs.writeFileSync(state.absoluteNewPath, state.content, 'utf-8');
  });

  // Delete the old files that were moved
  filesToDelete.forEach((oldPath) => {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  });

  console.log('--- Reorganization Completed ---');
}

migrateCodebase();
