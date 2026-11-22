export interface StaffMember {
  id: string;
  guildId: string;
  userId: string;
  grade: string;
  joinedStaffAt: Date | string;
  currentRoleStartedAt: Date | string;
  userTag?: string | null;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  isTutor: boolean;
  suspendedAt?: Date | string | null;
  suspendedReason?: string | null;
  suspendedById?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  warnings?: { id: string; reason: string; expiresAt?: Date | string | null }[];
  blacklistEntries?: { id: string; reason: string; endDate?: Date | string | null }[];
  stats?: {
    totalMessages: number;
    totalVoiceMinutes: number;
    sanctionsIssued: number;
  } | null;
  hierarchyGrades?: StaffMemberHierarchyGrade[];
}

export interface StaffHierarchy {
  id: string;
  guildId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sortOrder: number;
  parentHierarchyId?: string | null;
  responsableUserId?: string | null;
  discordRoleId?: string | null;
  poleRoleId?: string | null;
  separatorRoleId?: string | null;
  separatorStyle?: string | null;
  enabled: boolean;
  roles?: StaffRole[];
  memberGrades?: StaffMemberHierarchyGrade[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface StaffMemberHierarchyGrade {
  id: string;
  staffMemberId: string;
  hierarchyId: string;
  grade: string;
  joinedAt: Date | string;
  hierarchy?: StaffHierarchy | null;
  staffMember?: StaffMember | null;
}

export interface APIKey {
  id: string;
  guildId: string;
  createdByUserId: string;
  keyHash: string;
  displayKey: string;
  name: string;
  permissions: string[];
  isActive: boolean;
  lastUsedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface StaffRole {
  id: string;
  guildId: string;
  name: string;
  level: number;
  discordRoleId?: string | null;
  color?: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  hierarchyId?: string | null;
  isResponsable?: boolean;
}

export interface TestingPeriod {
  id: string;
  guildId: string;
  staffUserId: string;
  mentorId?: string | null;
  startDate: Date | string;
  endDate?: Date | string | null;
  status: 'ONGOING' | 'PASSED' | 'FAILED';
  plannedDurationDays: number;
  targetGrade?: string | null;
  hierarchyId?: string | null;
  hierarchy?: StaffHierarchy | null;
  notes?: string | null;
  staffMember?: StaffMember | null;
  mentor?: StaffMember | null;
  reports?: MentorReport[];
  fullChecklist?: TutoringChecklistEntry[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface TutoringItem {
  id: string;
  guildId: string;
  category: string;
  title: string;
  description?: string | null;
  sortOrder: number;
  hierarchyId?: string | null;
  grade?: string | null;
  hierarchy?: StaffHierarchy | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type TutoringItemState = 'UNCHECKED' | 'KNOWN' | 'ACQUIRED';

export interface TutoringChecklistEntry {
  item: TutoringItem;
  state: TutoringItemState;
  completedAt?: Date | string | null;
  completedByUserId?: string | null;
}

export interface MentorReport {
  id: string;
  testingPeriodId: string;
  authorId: string;
  type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  content: string;
  createdAt: Date | string;
  author?: StaffMember | null;
}

export interface StaffManagerNote {
  id: string;
  guildId: string;
  targetUserId: string;
  authorId: string;
  content: string;
  title?: string | null;
  category?: 'NOTE' | 'PRAISE' | 'WARNING' | 'FOLLOWUP';
  warningId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  author?: StaffMember;
}
