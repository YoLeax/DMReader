export const eventTypes = ['message', 'effect-message', 'gift', 'superchat', 'toast', 'interaction', 'entry-effect', 'like-click'] as const;
export type EventType = typeof eventTypes[number];
export type InteractionAction = '1' | '2' | '3' | '4' | '5';
export const eventLabels: Record<EventType, string> = { message: '普通弹幕', 'effect-message': '特效弹幕', gift: '赠送礼物', superchat: 'SC / 醒目留言', toast: '大航海', interaction: '观众互动', 'entry-effect': '进场特效', 'like-click': '观众点赞' };
export const eventDescriptions: Record<EventType, [string, string]> = {
  message: ['朗读消息正文；关闭后仍可使用互动设置指令。', '大家晚上好。'],
  'effect-message': ['朗读特效弹幕的文字正文，过滤标记。', '新年快乐，万事如意。'],
  gift: ['按单条通知的礼物数量致谢，连击期间冷却，不累计通知数量。', '感谢小明送出的 3 个小心心。'],
  superchat: ['朗读发送者和醒目留言正文。', '小明的醒目留言：今天的直播很精彩。'],
  toast: ['识别舰长、提督、总督；文案可确认时区分开通与续费。', '感谢小明续费舰长，1 个月。'],
  interaction: ['总开关与下方各行为开关同时开启才播报。', '感谢小明关注直播间。'],
  'entry-effect': ['用简短欢迎语替代特效文案，与普通进场共用冷却。', '欢迎小明进入直播间。'],
  'like-click': ['点赞通知不带可靠数量，只感谢点赞。', '感谢小明点赞。'],
};
export const interactionLabels: Record<InteractionAction, string> = { '1': '进场', '2': '关注', '3': '分享', '4': '特别关注', '5': '互相关注' };
export const interactionExamples: Record<InteractionAction, string> = { '1': '欢迎小明进入直播间。', '2': '感谢小明关注直播间。', '3': '感谢小明分享直播间。', '4': '感谢小明特别关注主播。', '5': '小明与主播互相关注啦。' };
export const defaultEventSpeech: Record<EventType, boolean> = { message: true, 'effect-message': false, gift: false, superchat: false, toast: false, interaction: false, 'entry-effect': false, 'like-click': false };
export const defaultInteractionActions: Record<InteractionAction, boolean> = { '1': false, '2': false, '3': false, '4': false, '5': false };
