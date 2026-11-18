import { m } from '../../i18n';
import { bot } from '../../stores/botLocale.svelte';
import type { WorkflowGraph } from '@kotbo/shared';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'welcome' | 'moderation' | 'support' | 'gamification';
  icon: string;
  graph: WorkflowGraph;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'auto-role-on-join',
    get name() { return m.wft_autorole(); },
    get description() { return m.wft_autorole_desc(); },
    category: 'welcome',
    icon: 'Shield',
    graph: {
      nodes: [
        {
          id: 'trig-join',
          type: 'OnMemberJoin',
          position: { x: 100, y: 160 },
          config: {},
        },
        {
          id: 'act-addrole',
          type: 'AddRole',
          position: { x: 480, y: 160 },
          config: { roleId: '' },
        },
      ],
      edges: [
        {
          id: 'e-join-exec',
          source: 'trig-join',
          sourceHandle: 'next',
          target: 'act-addrole',
          targetHandle: 'exec',
        },
        {
          id: 'e-join-member',
          source: 'trig-join',
          sourceHandle: 'member',
          target: 'act-addrole',
          targetHandle: 'member',
        },
      ],
    },
  },
  {
    id: 'welcome-dm',
    get name() { return m.wft_welcome_dm(); },
    get description() { return m.wft_welcome_dm_desc(); },
    category: 'welcome',
    icon: 'Mail',
    graph: {
      nodes: [
        {
          id: 'trig-join',
          type: 'OnMemberJoin',
          position: { x: 100, y: 140 },
          config: {},
        },
        {
          id: 'data-msg',
          type: 'ConstText',
          position: { x: 100, y: 340 },
          config: { get value() { return m.bot_wf_welcome_dm({}, bot()); } },
        },
        {
          id: 'act-senddm',
          type: 'SendDM',
          position: { x: 480, y: 180 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'e-join-exec',
          source: 'trig-join',
          sourceHandle: 'next',
          target: 'act-senddm',
          targetHandle: 'exec',
        },
        {
          id: 'e-join-member',
          source: 'trig-join',
          sourceHandle: 'member',
          target: 'act-senddm',
          targetHandle: 'member',
        },
        {
          id: 'e-msg-text',
          source: 'data-msg',
          sourceHandle: 'value',
          target: 'act-senddm',
          targetHandle: 'text',
        },
      ],
    },
  },
  {
    id: 'keyword-automod',
    get name() { return m.wft_keyword_mod(); },
    get description() { return m.wft_keyword_mod_desc(); },
    category: 'moderation',
    icon: 'AlertTriangle',
    graph: {
      nodes: [
        {
          id: 'trig-msg',
          type: 'OnMessageSend',
          position: { x: 60, y: 120 },
          config: {},
        },
        {
          id: 'data-msginfo',
          type: 'MessageInfo',
          position: { x: 60, y: 360 },
          config: {},
        },
        {
          id: 'data-word',
          type: 'ConstText',
          position: { x: 380, y: 520 },
          config: { value: 'badword' },
        },
        {
          id: 'logic-contains',
          type: 'TextContains',
          position: { x: 380, y: 360 },
          config: { caseSensitive: false },
        },
        {
          id: 'flow-if',
          type: 'If',
          position: { x: 440, y: 120 },
          config: {},
        },
        {
          id: 'act-timeout',
          type: 'TimeoutMember',
          position: { x: 760, y: 80 },
          config: { minutes: 10, get reason() { return m.bot_wf_badword_reason({}, bot()); } },
        },
        {
          id: 'data-warnmsg',
          type: 'ConstText',
          position: { x: 440, y: 680 },
          config: { get value() { return m.bot_wf_badword_warning({}, bot()); } },
        },
        {
          id: 'act-warn',
          type: 'SendMessage',
          position: { x: 760, y: 320 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'e-msg-exec',
          source: 'trig-msg',
          sourceHandle: 'next',
          target: 'flow-if',
          targetHandle: 'exec',
        },
        {
          id: 'e-msg-info',
          source: 'trig-msg',
          sourceHandle: 'message',
          target: 'data-msginfo',
          targetHandle: 'message',
        },
        {
          id: 'e-msg-content',
          source: 'data-msginfo',
          sourceHandle: 'content',
          target: 'logic-contains',
          targetHandle: 'text',
        },
        {
          id: 'e-word-val',
          source: 'data-word',
          sourceHandle: 'value',
          target: 'logic-contains',
          targetHandle: 'search',
        },
        {
          id: 'e-contains-if',
          source: 'logic-contains',
          sourceHandle: 'result',
          target: 'flow-if',
          targetHandle: 'condition',
        },
        {
          id: 'e-if-true',
          source: 'flow-if',
          sourceHandle: 'true',
          target: 'act-timeout',
          targetHandle: 'exec',
        },
        {
          id: 'e-msg-author',
          source: 'data-msginfo',
          sourceHandle: 'author',
          target: 'act-timeout',
          targetHandle: 'member',
        },
        {
          id: 'e-timeout-next',
          source: 'act-timeout',
          sourceHandle: 'next',
          target: 'act-warn',
          targetHandle: 'exec',
        },
        {
          id: 'e-msg-chan',
          source: 'trig-msg',
          sourceHandle: 'channel',
          target: 'act-warn',
          targetHandle: 'channel',
        },
        {
          id: 'e-warntext-val',
          source: 'data-warnmsg',
          sourceHandle: 'value',
          target: 'act-warn',
          targetHandle: 'text',
        },
      ],
    },
  },
  {
    id: 'ticket-auto-reply',
    get name() { return m.wft_ticket_reply(); },
    get description() { return m.wft_ticket_reply_desc(); },
    category: 'support',
    icon: 'TextBubble',
    graph: {
      nodes: [
        {
          id: 'trig-ticket',
          type: 'OnTicketCreated',
          position: { x: 100, y: 140 },
          config: {},
        },
        {
          id: 'data-msg',
          type: 'ConstText',
          position: { x: 100, y: 340 },
          config: { get value() { return m.bot_wf_ticket_greeting({}, bot()); } },
        },
        {
          id: 'act-sendmsg',
          type: 'SendMessage',
          position: { x: 480, y: 180 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'e-ticket-exec',
          source: 'trig-ticket',
          sourceHandle: 'next',
          target: 'act-sendmsg',
          targetHandle: 'exec',
        },
        {
          id: 'e-ticket-chan',
          source: 'trig-ticket',
          sourceHandle: 'channel',
          target: 'act-sendmsg',
          targetHandle: 'channel',
        },
        {
          id: 'e-msg-text',
          source: 'data-msg',
          sourceHandle: 'value',
          target: 'act-sendmsg',
          targetHandle: 'text',
        },
      ],
    },
  },
  {
    id: 'levelup-congrats',
    get name() { return m.wft_level_up(); },
    get description() { return m.wft_level_up_desc(); },
    category: 'gamification',
    icon: 'Sparkles',
    graph: {
      nodes: [
        {
          id: 'trig-levelup',
          type: 'OnLevelUp',
          position: { x: 100, y: 140 },
          config: {},
        },
        {
          id: 'data-msg',
          type: 'ConstText',
          position: { x: 100, y: 340 },
          config: { get value() { return m.bot_wf_levelup({}, bot()); } },
        },
        {
          id: 'act-senddm',
          type: 'SendDM',
          position: { x: 480, y: 180 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'e-level-exec',
          source: 'trig-levelup',
          sourceHandle: 'next',
          target: 'act-senddm',
          targetHandle: 'exec',
        },
        {
          id: 'e-level-member',
          source: 'trig-levelup',
          sourceHandle: 'member',
          target: 'act-senddm',
          targetHandle: 'member',
        },
        {
          id: 'e-msg-text',
          source: 'data-msg',
          sourceHandle: 'value',
          target: 'act-senddm',
          targetHandle: 'text',
        },
      ],
    },
  },
];
