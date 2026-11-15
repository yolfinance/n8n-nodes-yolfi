import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class YolfiApi implements ICredentialType {
	name = 'yolfiApi';
	displayName = 'Yolfi API';
	documentationUrl = 'https://docs.yolfi.com/en/api';
	icon = 'file:../nodes/Yolfi/yolfi.svg' as const;
	httpRequestNode = {
		name: 'Yolfi',
		docsUrl: 'https://docs.yolfi.com/en/api',
		apiBaseUrl: 'https://app.yolfi.com/api',
	};
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Organization API key from https://app.yolfi.com/settings/api-keys',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://app.yolfi.com/api',
			url: '/private/organization/current',
			method: 'GET',
			json: true,
			timeout: 30000,
			disableFollowRedirect: true,
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'success',
					value: false,
					message: 'Yolfi rejected this API key or its organization access',
				},
			},
		],
	};
}
