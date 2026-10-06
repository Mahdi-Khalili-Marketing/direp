import { config } from './config.js';
import { getSetting } from './db.js';

/**
 * Thin client for the official BoxAPI Instagram Direct & Comment API.
 * Docs: https://boxapi.ir/docs/instagram/dm/authentication/
 *
 * Several actions (follow_status, list_posts) are asynchronous: the HTTP call
 * only queues them and the result arrives later on the webhook.
 */
export interface BoxApiResponse<T = unknown> {
  success?: boolean;
  status?: boolean;
  message?: string;
  status_code?: number;
  data?: T;
}

export interface ConnectedAccount {
  id: string;
  username: string;
  instagram_user_id?: string;
  profile_photo?: string;
  is_active?: boolean;
  expires_at?: string;
}

export interface ServiceInfo {
  instagram_oauth_url?: string;
  login_redirect_url?: string;
  domain?: string;
  plan?: { name?: string; account_limit?: number; duration_days?: number };
  accounts?: { username: string; is_active: boolean; expires_at: string }[];
}

export interface Button {
  type: 'web_url' | 'postback';
  title: string;
  url?: string;
  payload?: string;
}

export class BoxApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class BoxApiClient {
  constructor(
    private readonly apiKey: () => string | undefined = () => getSetting('boxapi_key'),
    private readonly baseUrl = config.boxApiBaseUrl,
    private readonly dryRun = config.dryRun,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args)
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<BoxApiResponse<T>> {
    const key = this.apiKey();
    if (!key) throw new BoxApiError('کلید BoxAPI تنظیم نشده است', 400);

    if (this.dryRun && method === 'POST') {
      console.log(`[BoxAPI:dry-run] ${path}`, JSON.stringify(body).slice(0, 200));
      return { success: true, message: 'dry-run' };
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as BoxApiResponse<T>;
    if (!res.ok || json.success === false) {
      throw new BoxApiError(json.message || `BoxAPI HTTP ${res.status} on ${path}`, res.status);
    }
    return json;
  }

  /** Account info, including the page-connect link (instagram_oauth_url). */
  serviceInfo() {
    return this.call<ServiceInfo>('GET', '/service/info');
  }

  /** Pages connected through this BoxAPI account. `id` is the account_id used everywhere else. */
  accounts() {
    return this.call<ConnectedAccount[]>('GET', '/service/accounts');
  }

  sendMessage(accountId: string, recipientId: string, message: string, buttons?: Button[]) {
    return this.call('POST', '/service/actions/send_message', {
      account_id: accountId,
      recipient_id: recipientId,
      message,
      ...(buttons?.length ? { buttons } : {}),
    });
  }

  replyComment(accountId: string, commentId: string, message: string) {
    return this.call('POST', '/service/actions/reply_comment', {
      account_id: accountId,
      comment_id: commentId,
      message,
    });
  }

  /** DM someone about their comment. Instagram allows this up to 7 days after the comment. */
  privateReply(accountId: string, commentId: string, message: string, buttons?: Button[]) {
    return this.call('POST', '/service/actions/private_reply', {
      account_id: accountId,
      comment_id: commentId,
      message,
      ...(buttons?.length ? { buttons } : {}),
    });
  }

  /** Async: the answer arrives later on the webhook. */
  requestFollowStatus(accountId: string, customerId: string) {
    return this.call('POST', '/service/actions/follow_status', {
      account_id: accountId,
      customer_id: customerId,
    });
  }

  /** Async: the posts arrive later on the webhook as an action.list_posts event. */
  requestPosts(accountId: string, limit = 24) {
    return this.call('POST', '/service/actions/list_posts', {
      account_id: accountId,
      fields: ['id', 'media_type', 'media_url', 'thumbnail_url', 'permalink', 'caption', 'timestamp'],
      limit,
    });
  }
}

export const boxApi = new BoxApiClient();
