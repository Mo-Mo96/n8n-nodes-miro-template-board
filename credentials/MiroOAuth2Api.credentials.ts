import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// Lets each user connect their own Miro app via OAuth 2.0 (authorization code flow).
// n8n runs the login and refreshes expiring tokens automatically; this file only describes Miro's endpoints.
export class MiroOAuth2Api implements ICredentialType {
	name = 'miroOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Miro OAuth2 API';

	icon = 'file:../nodes/MiroTemplateBoard/miro.svg' as const;

	documentationUrl = 'https://developers.miro.com/docs/getting-started-with-oauth';

	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: 'https://miro.com/oauth/authorize',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://api.miro.com/v1/oauth/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'boards:read boards:write',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
