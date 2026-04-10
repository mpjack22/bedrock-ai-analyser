# Implementation Plan: Multi-Account Organization Support

## Overview

Add AWS Organizations multi-account support as a v2 feature to the Bedrock AI Analyser. All changes are additive — no existing v1 files are modified. New files: `organizationService.ts`, `v2QuotaFactory.ts`, `cross-account-role.yaml`. Modifications to `server.ts` are additive only (new routes, new UI elements). Uses `@aws-sdk/client-organizations` and `fast-check` for property-based tests.

## Tasks

- [x] 1. Install dependencies and set up test infrastructure
  - [x] 1.1 Add `@aws-sdk/client-organizations` to `package.json` dependencies and `fast-check` + `vitest` to devDependencies, then install
    - Run `npm install @aws-sdk/client-organizations` and `npm install -D fast-check vitest`
    - _Requirements: 1.1, 7.4_

  - [x] 1.2 Create `vitest.config.ts` at project root and add a `test` script to `package.json`
    - Configure vitest for TypeScript with `src` as the root
    - Add `"test": "vitest --run"` to `package.json` scripts
    - _Requirements: N/A (infrastructure)_

- [x] 2. Create the CloudFormation StackSet template
  - [x] 2.1 Create `cloudformation/cross-account-role.yaml`
    - Define `LinkedAccountId` parameter
    - Create `BedrockAnalyserReadRole` IAM role with trust policy allowing `sts:AssumeRole` from the Linked Account
    - Grant read-only permissions: `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics`, `cloudwatch:GetMetricData`, `servicequotas:ListServiceQuotas`, `servicequotas:GetServiceQuota`, `bedrock:ListFoundationModels`, `bedrock:GetFoundationModel`, `sts:GetCallerIdentity`, `iam:ListAccountAliases`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 3. Implement OrganizationService
  - [x] 3.1 Create `src/lib/organizationService.ts` with `OrgAccount` and `AssumedCredentials` interfaces and the `OrganizationService` class
    - Implement `listAccounts()`: call `organizations:ListAccounts`, paginate, filter to ACTIVE only, cache results with configurable TTL (default 5 min)
    - Implement `getLinkedAccountId()`: call `sts:GetCallerIdentity` and cache the result
    - Implement `getCredentials(accountId)`: return `null` for linked account; for member accounts, check credential cache, refresh if within 5 min of expiry, construct role ARN as `arn:aws:iam::<accountId>:role/BedrockAnalyserReadRole`, call `sts:AssumeRole` with 1-hour session duration
    - Handle errors gracefully: return empty list on `listAccounts` failure, return descriptive error on `AssumeRole` failure
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 3.2 Write property test: Account mapping preserves all fields (Property 1)
    - **Property 1: Account mapping preserves all fields**
    - Create `src/lib/__tests__/organizationService.test.ts`
    - Generate arbitrary Organizations API responses; assert mapped `OrgAccount` fields match source fields exactly
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 3.3 Write property test: Only ACTIVE accounts are returned (Property 3)
    - **Property 3: Only ACTIVE accounts are returned**
    - Generate account lists with mixed statuses; assert result contains only ACTIVE accounts
    - **Validates: Requirements 1.5**

  - [ ]* 3.4 Write property test: Account list caching avoids redundant API calls (Property 2)
    - **Property 2: Account list caching avoids redundant API calls**
    - Call `listAccounts()` multiple times within TTL; assert underlying API called exactly once
    - **Validates: Requirements 1.3**

  - [ ]* 3.5 Write property test: Role ARN construction (Property 6)
    - **Property 6: Role ARN construction**
    - Generate arbitrary 12-digit account IDs; assert constructed ARN matches `arn:aws:iam::<accountId>:role/BedrockAnalyserReadRole`
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 3.6 Write property test: Credential cache refresh threshold (Property 7)
    - **Property 7: Credential cache refresh threshold**
    - Generate credential expiration times relative to now; assert cached credentials returned when >5 min from expiry, STS called when ≤5 min from expiry
    - **Validates: Requirements 3.4**

  - [ ]* 3.7 Write property test: Linked account uses default credentials (Property 8)
    - **Property 8: Linked account uses default credentials**
    - Call `getCredentials()` with linked account ID, undefined, and null; assert returns `null` and STS not called
    - **Validates: Requirements 3.6, 5.3**

  - [ ]* 3.8 Write property test: Graceful degradation to single-account mode (Property 10)
    - **Property 10: Graceful degradation to single-account mode**
    - Simulate API errors on `listAccounts()`; assert empty list returned and no exception thrown
    - **Validates: Requirements 7.2, 7.3**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement V2 QuotaService Factory
  - [x] 5.1 Create `src/lib/v2QuotaFactory.ts` with `CrossAccountQuotaService` class and `createQuotaServiceForAccount` factory function
    - `CrossAccountQuotaService` extends or mirrors `QuotaService` but initializes SDK clients with explicit credentials
    - Factory returns standard `QuotaService` for linked account (or when `accountId` is undefined), and `CrossAccountQuotaService` with assumed credentials for member accounts
    - _Requirements: 4.5, 5.3, 5.4, 7.4_

  - [ ]* 5.2 Write property test: Cross-account QuotaService uses assumed credentials (Property 9)
    - **Property 9: Cross-account QuotaService uses assumed credentials**
    - Create `src/lib/__tests__/v2QuotaFactory.test.ts`
    - Generate arbitrary account IDs and regions; assert factory produces QuotaService with correct credentials injected
    - **Validates: Requirements 4.5, 5.4**

- [x] 6. Add V2 API routes to server.ts
  - [x] 6.1 Add `OrganizationService` and `v2QuotaFactory` imports and initialization in `src/web/server.ts`
    - Instantiate `OrganizationService` alongside existing services
    - _Requirements: 5.1, 7.4_

  - [x] 6.2 Add `GET /api/v2/accounts` endpoint in `handleRequest`
    - Return `{ accounts: OrgAccount[], linkedAccountId: string }`
    - Handle errors gracefully (return empty list on failure)
    - _Requirements: 5.1, 7.2_

  - [x] 6.3 Add `accountId` query parameter support to existing data endpoints
    - For `/api/timeseries`, `/api/quotas`, `/api/usage`, `/api/agents`, `/api/predictions`, `/api/active-models`: read optional `accountId` param, resolve credentials via `OrganizationService`, create account-specific `QuotaService` via factory
    - Return HTTP 403 with descriptive error when `AssumeRole` fails
    - Return HTTP 400 when `accountId` references non-existent account
    - Use default credentials when `accountId` is absent or matches linked account
    - _Requirements: 4.1, 4.2, 4.5, 5.2, 5.3, 5.4, 5.5_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Add Account Selector UI to dashboard
  - [x] 8.1 Add account selector HTML/CSS/JS to the `getHTML()` function in `src/web/server.ts`
    - Add searchable `<input>` + dropdown list in the dashboard header, positioned between the account badge and region selector
    - Implement vanilla JS: fetch `/api/v2/accounts` on load, populate dropdown, filter by name and ID on input (case-insensitive)
    - Include "Current Account" as default option
    - On selection change: update `currentAccountId` variable, update account badge display, append `&accountId=<id>` to all API fetch calls, call `loadAll()` to refresh data
    - Show loading indicators on charts/data sections while data loads for newly selected account
    - If no Organization accounts available, show only "Current Account" option
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3, 4.4, 7.2_

  - [ ]* 8.2 Write property test: Account display format (Property 4)
    - **Property 4: Account display format**
    - Create `src/lib/__tests__/accountFilter.test.ts`
    - Generate arbitrary account names and 12-digit IDs; assert display string matches `<accountName> (<accountId>)`
    - **Validates: Requirements 2.2**

  - [ ]* 8.3 Write property test: Account search filters by name and ID (Property 5)
    - **Property 5: Account search filters by name and ID**
    - Generate arbitrary search strings and account lists; assert filtered results include exactly those accounts where name or ID contains the search string (case-insensitive)
    - **Validates: Requirements 2.3**

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- All v2 code is additive — no existing v1 files (`quotaService.ts`, `predictionService.ts`, `chatService.ts`, `userStore.ts`, `config.ts`) are modified
- The `CrossAccountQuotaService` in `v2QuotaFactory.ts` mirrors `QuotaService` with credential injection, preserving v1 code integrity
