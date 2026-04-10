# Requirements Document

## Introduction

This feature adds AWS Organizations multi-account support (v2) to the Bedrock AI Analyser dashboard. The analyser runs from a single linked account within an AWS Organization and enables users to view Bedrock usage data for any account in the organization. Users can search for and select a target account from a dropdown, and all dashboard data refreshes to show metrics for that account. Cross-account access is achieved via STS AssumeRole with a consistent IAM role deployed across member accounts using a CloudFormation StackSet template. The existing v1 codebase remains unmodified; all v2 functionality is additive.

## Glossary

- **Analyser**: The Bedrock AI Analyser Node.js/TypeScript web application that serves the monitoring dashboard
- **Organization**: An AWS Organization containing multiple AWS accounts managed under a single management account
- **Management_Account**: The AWS account that owns the AWS Organization and has permission to call `organizations:ListAccounts`
- **Member_Account**: Any AWS account that belongs to the Organization and contains Bedrock usage data to be monitored
- **Linked_Account**: The single AWS account where the Analyser application is deployed and running
- **Cross_Account_Role**: A consistent IAM role named `BedrockAnalyserReadRole` deployed in each Member_Account that trusts the Linked_Account
- **Account_Selector**: A searchable dropdown UI component in the dashboard header that allows users to pick a target account
- **Account_Badge**: The existing header element that displays the currently active AWS account ID and alias
- **QuotaService**: The existing service class (`src/lib/quotaService.ts`) that queries CloudWatch metrics and Service Quotas
- **OrganizationService**: A new v2 service responsible for listing Organization accounts and assuming cross-account roles via STS
- **StackSet_Template**: A CloudFormation template that deploys the Cross_Account_Role into all Member_Accounts via AWS CloudFormation StackSets

## Requirements

### Requirement 1: List Organization Accounts

**User Story:** As a dashboard user, I want to see all AWS accounts in my Organization, so that I can select which account's Bedrock usage to view.

#### Acceptance Criteria

1. WHEN the Analyser starts, THE OrganizationService SHALL retrieve the list of all accounts from the AWS Organization using the `organizations:ListAccounts` API
2. THE OrganizationService SHALL return each account's ID, name, email, and status
3. THE OrganizationService SHALL cache the account list for a configurable duration to avoid excessive API calls
4. IF the `organizations:ListAccounts` API call fails, THEN THE OrganizationService SHALL return an empty account list and log the error
5. WHEN the account list is retrieved, THE OrganizationService SHALL exclude accounts with a status other than `ACTIVE`

### Requirement 2: Account Selector UI

**User Story:** As a dashboard user, I want a searchable account selector in the dashboard header, so that I can quickly find and switch to any account in my Organization.

#### Acceptance Criteria

1. THE Account_Selector SHALL display in the dashboard header alongside the existing region selector
2. THE Account_Selector SHALL show each account as `<account_name> (<account_id>)`
3. WHEN the user types in the Account_Selector, THE Account_Selector SHALL filter the account list by matching against both account name and account ID
4. THE Account_Selector SHALL include a "Current Account" option that represents the Linked_Account where the Analyser is running
5. WHEN the dashboard loads, THE Account_Selector SHALL default to the "Current Account" option
6. IF no Organization accounts are available, THEN THE Account_Selector SHALL display only the "Current Account" option and remain functional

### Requirement 3: Cross-Account Role Assumption

**User Story:** As a dashboard user, I want the analyser to assume a role in the selected account, so that I can view Bedrock metrics from that account.

#### Acceptance Criteria

1. WHEN a user selects a Member_Account from the Account_Selector, THE OrganizationService SHALL call `sts:AssumeRole` to obtain temporary credentials for the Cross_Account_Role in that account
2. THE OrganizationService SHALL construct the role ARN as `arn:aws:iam::<account_id>:role/BedrockAnalyserReadRole`
3. THE OrganizationService SHALL set the session duration to 1 hour for assumed role credentials
4. THE OrganizationService SHALL cache assumed role credentials and refresh them when they are within 5 minutes of expiration
5. IF the `sts:AssumeRole` call fails, THEN THE OrganizationService SHALL return an error indicating the Cross_Account_Role is not configured in the target account
6. WHEN the "Current Account" option is selected, THE OrganizationService SHALL use the default credentials of the Linked_Account without assuming any role

### Requirement 4: Dashboard Data Refresh on Account Switch

**User Story:** As a dashboard user, I want all dashboard charts and data to refresh when I switch accounts, so that I see accurate metrics for the selected account.

#### Acceptance Criteria

1. WHEN a user selects a different account from the Account_Selector, THE Analyser SHALL reload all dashboard data (time series, quotas, usage, predictions, agents) for the selected account
2. THE Analyser SHALL pass the selected account ID as a query parameter to all API endpoints
3. WHEN the selected account changes, THE Account_Badge SHALL update to display the selected account's name and ID
4. WHILE data is loading for a newly selected account, THE Analyser SHALL display a loading indicator on each chart and data section
5. THE Analyser SHALL create new QuotaService instances using the temporary credentials obtained for the selected account

### Requirement 5: V2 API Endpoints

**User Story:** As a dashboard developer, I want new v2 API endpoints that support account selection, so that the frontend can request data for any account.

#### Acceptance Criteria

1. THE Analyser SHALL expose a `GET /api/v2/accounts` endpoint that returns the list of Organization accounts
2. THE Analyser SHALL expose all existing data endpoints with an optional `accountId` query parameter (e.g., `/api/timeseries?accountId=123456789012`)
3. WHEN the `accountId` parameter is absent or set to the Linked_Account's ID, THE Analyser SHALL use default credentials
4. WHEN the `accountId` parameter is set to a Member_Account's ID, THE Analyser SHALL use assumed role credentials for that account
5. IF the `accountId` parameter references an account where the Cross_Account_Role cannot be assumed, THEN THE Analyser SHALL return HTTP 403 with a descriptive error message

### Requirement 6: Cross-Account IAM Role Template

**User Story:** As an AWS administrator, I want a CloudFormation StackSet template that deploys the required IAM role to all member accounts, so that the analyser can access Bedrock metrics across the Organization.

#### Acceptance Criteria

1. THE StackSet_Template SHALL create an IAM role named `BedrockAnalyserReadRole` in the target account
2. THE StackSet_Template SHALL configure the trust policy to allow `sts:AssumeRole` only from the Linked_Account's IAM role or account principal
3. THE StackSet_Template SHALL grant the role read-only permissions: `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics`, `cloudwatch:GetMetricData`, `servicequotas:ListServiceQuotas`, `servicequotas:GetServiceQuota`, `bedrock:ListFoundationModels`, `bedrock:GetFoundationModel`, `sts:GetCallerIdentity`, `iam:ListAccountAliases`
4. THE StackSet_Template SHALL accept the Linked_Account ID as a parameter for the trust policy
5. THE StackSet_Template SHALL use least-privilege permissions and restrict the resource scope where possible

### Requirement 7: V1 Code Preservation

**User Story:** As a developer, I want the existing v1 code to remain unmodified, so that the current single-account functionality continues to work without regression.

#### Acceptance Criteria

1. THE Analyser SHALL implement all multi-account functionality as new files and additive code paths
2. THE Analyser SHALL maintain backward compatibility so that the dashboard functions identically when no Organization is available
3. WHEN the OrganizationService cannot list accounts, THE Analyser SHALL fall back to single-account mode using the Linked_Account's default credentials
4. THE Analyser SHALL not modify the existing `QuotaService`, `PredictionService`, `ChatService`, `UserStore`, or `config.ts` files

### Requirement 8: Linked Account IAM Permissions

**User Story:** As an AWS administrator, I want the Linked Account's IAM role to have the necessary permissions for Organization and STS operations, so that the analyser can discover accounts and assume cross-account roles.

#### Acceptance Criteria

1. THE Analyser documentation SHALL specify that the Linked_Account's IAM role requires `organizations:ListAccounts` permission
2. THE Analyser documentation SHALL specify that the Linked_Account's IAM role requires `sts:AssumeRole` permission for the Cross_Account_Role ARN pattern `arn:aws:iam::*:role/BedrockAnalyserReadRole`
3. THE StackSet_Template or documentation SHALL provide an updated IAM policy for the Linked_Account that includes the new permissions alongside the existing ones
