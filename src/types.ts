export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { FINISH: 2 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number };
  voice_item?: { media?: CdnMedia; sample_rate?: number; text?: string };
  file_item?: { media?: CdnMedia; file_name?: string; md5?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number; video_md5?: string };
}

export interface WeixinMessage {
  seq?: number | string;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
  message_id?: string;
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

export interface GetUploadUrlResp {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WeixinRaw {
  from_user_id: string;
  to_user_id: string;
  session_id: string;
  context_token: string;
}
