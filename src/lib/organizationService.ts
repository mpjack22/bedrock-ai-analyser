import {
  OrganizationsClient,
  ListAccountsCommand,
  type Account,
} from '@aws-sdk/client-organizations';
import {
  STSClient,
  AssumeRoleCommand,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';

export interface OrgAccount {
  accountId: string;
  accountName: string;
  email: string;
  status: string;
}

export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export class OrganizationService {
  private orgsClient: OrganizationsClient;
  private stsClient: STSClient;
  private accountCache: OrgAccount[] | null = null;
  private accountCacheExpiry: number = 0;
  private credentialCache: Map<string, AssumedCredentials> = new Map();
  private linkedAccountId: string | null = null;
  private cacheTtlMs: number;

  constructor(cacheTtlMs?: number) {
    this.cacheTtlMs = cacheTtlMs ?? 300000; // default 5 minutes
    this.orgsClient = new OrganizationsClient({});
    this.stsClient = new STSClient({});
  }

  /** Lists all ACTIVE accounts in the Organization. Returns [] on failure. */
  async listAccounts(): Promise<OrgAccount[]> {
    const now = Date.now();
    if (this.accountCache && now < this.accountCacheExpiry) {
      return this.accountCache;
    }

    try {
      const accounts: Account[] = [];
      let nextToken: string | undefined;

      do {
        const command = new ListAccountsCommand({ NextToken: nextToken });
        const response = await this.orgsClient.send(command);

        if (response.Accounts) {
          accounts.push(...response.Accounts);
        }
        nextToken = response.NextToken;
      } while (nextToken);

      const activeAccounts: OrgAccount[] = accounts
        .filter((acct) => acct.Status === 'ACTIVE')
        .map((acct) => ({
          accountId: acct.Id || '',
          accountName: acct.Name || '',
          email: acct.Email || '',
          status: acct.Status || '',
        }));

      this.accountCache = activeAccounts;
      this.accountCacheExpiry = now + this.cacheTtlMs;

      return activeAccounts;
    } catch (error) {
      console.error('Error listing organization accounts:', error);
      return [];
    }
  }

  /** Returns the linked account's own account ID. */
  async getLinkedAccountId(): Promise<string> {
    if (this.linkedAccountId) {
      return this.linkedAccountId;
    }

    const command = new GetCallerIdentityCommand({});
    const response = await this.stsClient.send(command);
    this.linkedAccountId = response.Account || '';
    return this.linkedAccountId;
  }

  /** Returns temporary credentials for the given account, or null for the linked account. */
  async getCredentials(accountId?: string | null): Promise<AssumedCredentials | null> {
    if (!accountId) {
      return null;
    }

    const linkedId = await this.getLinkedAccountId();
    if (accountId === linkedId) {
      return null;
    }

    const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const cached = this.credentialCache.get(accountId);
    if (cached) {
      const timeUntilExpiry = cached.expiration.getTime() - Date.now();
      if (timeUntilExpiry > REFRESH_THRESHOLD_MS) {
        return cached;
      }
    }

    const roleArn = `arn:aws:iam::${accountId}:role/BedrockAnalyserReadRole`;

    try {
      const command = new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'BedrockAnalyserSession',
        DurationSeconds: 3600, // 1 hour
      });

      const response = await this.stsClient.send(command);
      const credentials = response.Credentials;

      if (!credentials || !credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
        throw new Error(`Invalid credentials returned for account ${accountId}`);
      }

      const assumed: AssumedCredentials = {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
        expiration: credentials.Expiration,
      };

      this.credentialCache.set(accountId, assumed);
      return assumed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot access account ${accountId}: BedrockAnalyserReadRole is not configured or cannot be assumed. ${message}`
      );
    }
  }
}
