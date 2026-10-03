import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MiroApi implements ICredentialType {
	name = 'miroApi';

	displayName = 'Miro API';
	icon = {
		light: 'file:../nodes/MiroTemplateBoard/example.svg',
		dark: 'file:../nodes/MiroTemplateBoard/example.dark.svg',
	} as const;

	documentationUrl = 'https://developers.miro.com/docs/getting-started-with-oauth';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.miro.com',
			url: '/v2/boards', 
			qs: { limit: 1 },
		},
	};
}