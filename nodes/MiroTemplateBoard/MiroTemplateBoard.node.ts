import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

const MIRO_API = 'https://api.miro.com/v2';

type MiroContext = IExecuteFunctions | ILoadOptionsFunctions;

interface Frame {
	id: string;
	title: string;
	width: number;
	height: number;
}

interface PopulatedFrame {
	title: string;
	frameId: string;
	textId: string;
}

// Accepts a full board link (https://miro.com/app/board/uXjVAbC123=/) or a bare board ID.
function extractBoardId(input: string): string {
	const trimmed = (input ?? '').trim();
	const match = trimmed.match(/\/board\/([^/?#]+)/);
	return decodeURIComponent(match ? match[1] : trimmed);
}

// Sends one authenticated request to the Miro API using the saved "Miro API" credential.
async function miroRequest(
	this: MiroContext,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	body?: IDataObject,
): Promise<IDataObject> {
	return (await this.helpers.httpRequestWithAuthentication.call(this, 'miroApi', {
		method,
		url: `${MIRO_API}${path}`,
		qs,
		body,
		json: true,
	})) as IDataObject;
}

// Returns every frame on a board, following Miro's page cursor until there are no more pages.
async function getAllFrames(this: MiroContext, boardId: string): Promise<Frame[]> {
	const frames: Frame[] = [];
	let cursor: string | undefined;
	do {
		const qs: IDataObject = { type: 'frame', limit: 50 };
		if (cursor) qs.cursor = cursor;
		const page = await miroRequest.call(
			this,
			'GET',
			`/boards/${encodeURIComponent(boardId)}/items`,
			qs,
		);
		for (const item of (page.data as IDataObject[]) ?? []) {
			const data = (item.data as IDataObject) ?? {};
			const geometry = (item.geometry as IDataObject) ?? {};
			frames.push({
				id: item.id as string,
				title: ((data.title as string) ?? '').trim(),
				width: Number(geometry.width) || 800,
				height: Number(geometry.height) || 600,
			});
		}
		cursor = page.cursor as string | undefined;
	} while (cursor);
	return frames;
}

// Lists anything about the frame titles that would make title-based mapping ambiguous.
function findTitleProblems(frames: Frame[]): string[] {
	const counts: Record<string, number> = {};
	for (const frame of frames) counts[frame.title] = (counts[frame.title] ?? 0) + 1;

	const problems: string[] = [];
	if (frames.length === 0) problems.push('The board has no frames.');
	if (counts[''] > 0) problems.push(`${counts['']} frame(s) have no title.`);
	for (const [title, count] of Object.entries(counts)) {
		if (title && count > 1) problems.push(`Title "${title}" is used by ${count} frames.`);
	}
	return problems;
}

// Groups frames by title, so we can tell "missing" (0) from "ambiguous" (2+).
function framesByTitle(frames: Frame[]): Map<string, Frame[]> {
	const lookup = new Map<string, Frame[]>();
	for (const frame of frames) {
		lookup.set(frame.title, [...(lookup.get(frame.title) ?? []), frame]);
	}
	return lookup;
}

// Turns the optional sharing dropdowns into Miro's policy object.
// Dropdowns left on "Keep Miro Default" are skipped, so only real choices are sent.
// Returns undefined when nothing was set, so the copy request has no policy at all.
function buildPolicy(sharing: IDataObject): IDataObject | undefined {
	const sharingKeys = ['access', 'teamAccess', 'organizationAccess', 'inviteToAccountAndBoardLinkAccess'];
	const permissionKeys = ['sharingAccess', 'copyAccess', 'collaborationToolsStartAccess'];

	const pick = (keys: string[]): IDataObject | undefined => {
		const picked: IDataObject = {};
		for (const key of keys) if (sharing[key] !== undefined && sharing[key] !== '') picked[key] = sharing[key];
		return Object.keys(picked).length > 0 ? picked : undefined;
	};

	const sharingPolicy = pick(sharingKeys);
	const permissionsPolicy = pick(permissionKeys);
	if (!sharingPolicy && !permissionsPolicy) return undefined;

	const policy: IDataObject = {};
	if (sharingPolicy) policy.sharingPolicy = sharingPolicy;
	if (permissionsPolicy) policy.permissionsPolicy = permissionsPolicy;
	return policy;
}

export class MiroTemplateBoard implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Miro Template Board',
		name: 'miroTemplateBoard',
		icon: { light: 'file:example.svg', dark: 'file:example.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Copy a Miro board and fill its frames with workflow data',
		defaults: {
			name: 'Miro Template Board',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'miroApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Source Board',
				name: 'sourceBoard',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://miro.com/app/board/uXjVAbC123=/',
				description: 'Link to (or ID of) the Miro board to use as the template. It is never changed.',
			},
			{
				displayName: 'Destination Team ID',
				name: 'teamId',
				type: 'string',
				default: '',
				placeholder: '3458764512345678901',
				description:
					'ID of the Miro team where new boards are created. Leave empty to use the source board\'s team.',
			},
			{
				displayName: 'New Board Name',
				name: 'boardName',
				type: 'string',
				default: '',
				placeholder: 'Call with {{ $json.customer }}',
				description:
					'Name for each new board (max 60 characters). Leave empty to use "Copy of" plus the source board name.',
			},
			{
				displayName: 'Frame Content',
				name: 'frameContent',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				typeOptions: {
					loadOptionsDependsOn: ['sourceBoard'],
					resourceMapper: {
						resourceMapperMethod: 'getFrameFields',
						mode: 'add',
						valuesLabel: 'Frame Content',
						fieldWords: {
							singular: 'frame',
							plural: 'frames',
						},
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: false,
						noFieldsError: 'Enter a Source Board link above to load its frames.',
					},
				},
			},
			{
				displayName: 'Customize Sharing',
				name: 'customizeSharing',
				type: 'boolean',
				default: false,
				description:
					"Whether to set access rules on each new board. When off, new boards follow Miro's defaults and your team or organization settings.",
			},
			{
				displayName: 'Anyone With the Link',
				name: 'access',
				type: 'options',
				default: '',
				description: 'What people outside the team can do if they have the board link',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'No Access', value: 'private' },
					{ name: 'Can View', value: 'view' },
					{ name: 'Can Comment', value: 'comment' },
					{ name: 'Can Edit', value: 'edit' },
				],
			},
			{
				displayName: 'Team Members',
				name: 'teamAccess',
				type: 'options',
				default: '',
				description: 'What members of the destination team can do',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'No Access', value: 'private' },
					{ name: 'Can View', value: 'view' },
					{ name: 'Can Comment', value: 'comment' },
					{ name: 'Can Edit', value: 'edit' },
				],
			},
			{
				displayName: 'Organization Members',
				name: 'organizationAccess',
				type: 'options',
				default: '',
				description: 'What members of your Miro organization can do',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'No Access', value: 'private' },
					{ name: 'Can View', value: 'view' },
					{ name: 'Can Comment', value: 'comment' },
					{ name: 'Can Edit', value: 'edit' },
				],
			},
			{
				displayName: 'Invite Link Role',
				name: 'inviteToAccountAndBoardLinkAccess',
				type: 'options',
				default: '',
				description: 'Role given to people who join through the invite-to-team-and-board link',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'Link Disabled', value: 'no_access' },
					{ name: 'Viewer', value: 'viewer' },
					{ name: 'Commenter', value: 'commenter' },
					{ name: 'Editor', value: 'editor' },
					{ name: 'Co-Owner', value: 'coowner' },
				],
			},
			{
				displayName: 'Who Can Change Sharing',
				name: 'sharingAccess',
				type: 'options',
				default: '',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'Team Members With Editing Rights', value: 'team_members_with_editing_rights' },
					{ name: 'Owner and Co-Owners Only', value: 'owner_and_coowners' },
				],
			},
			{
				displayName: 'Who Can Copy and Export',
				name: 'copyAccess',
				type: 'options',
				default: '',
				description: 'Who can copy the board or its objects, download images, and save it as a template or PDF',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'Anyone', value: 'anyone' },
					{ name: 'Team Members', value: 'team_members' },
					{ name: 'Team Editors', value: 'team_editors' },
					{ name: 'Board Owner Only', value: 'board_owner' },
				],
			},
			{
				displayName: 'Who Can Start Collaboration Tools',
				name: 'collaborationToolsStartAccess',
				type: 'options',
				default: '',
				description: 'Who can start the timer, voting, video chat, screen sharing, and attention management',
				displayOptions: { show: { customizeSharing: [true] } },
				options: [
					{ name: 'Keep Miro Default', value: '' },
					{ name: 'All Editors', value: 'all_editors' },
					{ name: 'Owner and Co-Owners Only', value: 'board_owners_and_coowners' },
				],
			},
		],
	};

	methods = {
		resourceMapping: {
			// Runs in the editor: reads the source board and turns each frame title into a mapping field.
			// It only reads the board; it never copies or changes anything.
			async getFrameFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const boardId = extractBoardId(this.getCurrentNodeParameter('sourceBoard') as string);
				if (!boardId) {
					return { fields: [], emptyFieldsNotice: 'Paste a Source Board link above to load its frames.' };
				}

				// Problems are returned as a message shown in place of the fields, not thrown.
				// Throwing here makes n8n hide the whole Frame Content section without saying why.
				let frames: Frame[];
				try {
					frames = await getAllFrames.call(this, boardId);
				} catch {
					return {
						fields: [],
						emptyFieldsNotice:
							"Can't open this board. Check the Source Board link and that your Miro account has access to it.",
					};
				}

				const problems = findTitleProblems(frames);
				if (problems.length > 0) {
					return {
						fields: [],
						emptyFieldsNotice: `${problems.join(' ')} Give every frame a unique, non-empty title in Miro, then refresh the field list.`,
					};
				}

				return {
					fields: frames.map((frame) => ({
						id: frame.title, // The title is the key. Never the source frame ID.
						displayName: frame.title,
						type: 'string',
						required: true, // Every frame must get content; n8n shows a red triangle while one is missing.
						defaultMatch: false,
						canBeUsedToMatch: false,
						display: true,
					})),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				// ---------- 1. Read this item's settings ----------
				const sourceBoardId = extractBoardId(this.getNodeParameter('sourceBoard', itemIndex) as string);
				if (!sourceBoardId) {
					throw new NodeOperationError(this.getNode(), 'Source Board is empty', { itemIndex });
				}

				const mapping = this.getNodeParameter('frameContent', itemIndex) as ResourceMapperValue;
				const mappedContent: Record<string, string> = {};
				for (const [title, value] of Object.entries(mapping.value ?? {})) {
					if (value !== null && value !== undefined && String(value).trim() !== '') {
						mappedContent[title] = String(value);
					}
				}

				// Every frame field must have content for this item. Expressions can resolve to empty
				// (e.g. a blank cell), so this is checked per item, before anything is created.
				const emptyFrames = Object.entries(mapping.value ?? {})
					.filter(([, value]) => value === null || value === undefined || String(value).trim() === '')
					.map(([title]) => `"${title}"`);
				if (emptyFrames.length > 0 || Object.keys(mappedContent).length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						emptyFrames.length > 0
							? `Nothing was copied: no content for frame ${emptyFrames.join(', ')}.`
							: 'Nothing was copied: no frame content was provided.',
						{
							itemIndex,
							description:
								'Fill every frame field. If a field uses an expression, check that the input item has a value for it.',
						},
					);
				}

				// ---------- 2. Preflight: check the source board BEFORE creating anything ----------
				const sourceBoard = await miroRequest.call(
					this,
					'GET',
					`/boards/${encodeURIComponent(sourceBoardId)}`,
				);
				const sourceFrames = await getAllFrames.call(this, sourceBoardId);
				const problems = findTitleProblems(sourceFrames);
				const sourceTitles = new Set(sourceFrames.map((frame) => frame.title));
				for (const title of Object.keys(mappedContent)) {
					if (!sourceTitles.has(title)) {
						problems.push(`Mapped frame "${title}" no longer exists on the source board.`);
					}
				}
				if (problems.length > 0) {
					throw new NodeOperationError(
						this.getNode(),
						`Source board isn't ready, so nothing was copied: ${problems.join(' ')}`,
						{ itemIndex, description: 'Fix the frame titles on the source board, then reload the Frame Content fields.' },
					);
				}

				const sourceTeam = (sourceBoard.team as IDataObject) ?? {};
				const teamId =
					((this.getNodeParameter('teamId', itemIndex, '') as string) || '').trim() ||
					((sourceTeam.id as string) ?? '');
				if (!teamId) {
					throw new NodeOperationError(this.getNode(), 'No destination team could be determined', {
						itemIndex,
						description: 'Enter a Destination Team ID.',
					});
				}

				const requestedName = ((this.getNodeParameter('boardName', itemIndex, '') as string) || '').trim();
				const boardName = (requestedName || `Copy of ${sourceBoard.name as string}`).slice(0, 60);

				const sharingKeys = [
					'access',
					'teamAccess',
					'organizationAccess',
					'inviteToAccountAndBoardLinkAccess',
					'sharingAccess',
					'copyAccess',
					'collaborationToolsStartAccess',
				];
				const sharingChoices: IDataObject = {};
				if (this.getNodeParameter('customizeSharing', itemIndex, false) as boolean) {
					for (const key of sharingKeys) {
						sharingChoices[key] = this.getNodeParameter(key, itemIndex, '') as string;
					}
				}
				const policy = buildPolicy(sharingChoices);

				// ---------- 3. Copy the board ----------
				const copyBody: IDataObject = { name: boardName, teamId };
				if (policy) copyBody.policy = policy;
				const newBoard = await miroRequest.call(
					this,
					'PUT',
					'/boards',
					{ copy_from: sourceBoardId },
					copyBody,
				);
				const newBoardId = newBoard.id as string;
				const newBoardUrl = newBoard.viewLink as string;

				// ---------- 4. Fill the copy. From here on, a board exists, so errors must report it. ----------
				const populated: PopulatedFrame[] = [];
				try {
					// Find the copied frames by title. Retry briefly in case the copy is still settling.
					const wantedTitles = Object.keys(mappedContent);
					let lookup = new Map<string, Frame[]>();
					for (let attempt = 1; attempt <= 3; attempt++) {
						lookup = framesByTitle(await getAllFrames.call(this, newBoardId));
						if (wantedTitles.every((title) => lookup.has(title))) break;
						if (attempt < 3) await sleep(2000);
					}

					for (const [title, content] of Object.entries(mappedContent)) {
						const matches = lookup.get(title) ?? [];
						if (matches.length !== 1) {
							throw new Error(
								matches.length === 0
									? `No frame titled "${title}" on the copied board.`
									: `${matches.length} frames titled "${title}" on the copied board.`,
							);
						}
						const frame = matches[0];

						// Center the text in the frame. Child positions are relative to the frame's top-left corner.
						const text = await miroRequest.call(
							this,
							'POST',
							`/boards/${encodeURIComponent(newBoardId)}/texts`,
							{},
							{
								data: { content },
								parent: { id: frame.id },
								position: { x: frame.width / 2, y: frame.height / 2 },
								geometry: { width: Math.round(frame.width * 0.8) },
							},
						);
						populated.push({ title, frameId: frame.id, textId: text.id as string });
					}
				} catch (fillError) {
					const done = populated.map((p) => p.title).join(', ') || 'none';
					throw new NodeOperationError(
						this.getNode(),
						`Board was copied, but filling it failed: ${(fillError as Error).message}`,
						{
							itemIndex,
							description: `The new board was kept so you can inspect it: ${newBoardUrl} (ID ${newBoardId}). Frames already filled: ${done}.`,
						},
					);
				}

				// ---------- 5. Output one result per input item ----------
				returnData.push({
					json: {
						boardId: newBoardId,
						boardUrl: newBoardUrl,
						boardName,
						teamId,
						sourceBoardId,
						appliedPolicy: policy ?? 'Miro defaults',
						populatedFrames: populated,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}