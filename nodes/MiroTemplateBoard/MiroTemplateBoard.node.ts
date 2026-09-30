import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const MIRO_API = 'https://api.miro.com/v2';

// Accepts a full board link (https://miro.com/app/board/uXjVAbC123=/) or a bare board ID.
function extractBoardId(input: string): string {
	const trimmed = input.trim();
	const match = trimmed.match(/\/board\/([^/?#]+)/);
	return decodeURIComponent(match ? match[1] : trimmed);
}

// Sends one authenticated request to the Miro API using the saved "Miro API" credential.
async function miroRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject> {
	return (await this.helpers.httpRequestWithAuthentication.call(this, 'miroApi', {
		method,
		url: `${MIRO_API}${path}`,
		qs,
		json: true,
	})) as IDataObject;
}

// Returns every frame on a board, following Miro's page cursor until there are no more pages.
async function getAllFrames(this: IExecuteFunctions, boardId: string): Promise<IDataObject[]> {
	const frames: IDataObject[] = [];
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
		frames.push(...((page.data as IDataObject[]) ?? []));
		cursor = page.cursor as string | undefined;
	} while (cursor);
	return frames;
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
				description: 'Link to (or ID of) the Miro board to use as the template',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const sourceBoard = this.getNodeParameter('sourceBoard', itemIndex) as string;
				const boardId = extractBoardId(sourceBoard);
				if (!boardId) {
					throw new NodeOperationError(this.getNode(), 'Source Board is empty', { itemIndex });
				}

				// 1. Can we read the board at all?
				const board = await miroRequest.call(this, 'GET', `/boards/${encodeURIComponent(boardId)}`);

				// 2. Find every frame and its title.
				const frames = (await getAllFrames.call(this, boardId)).map((frame) => ({
					id: frame.id as string,
					title: (((frame.data as IDataObject) ?? {}).title as string) ?? '',
				}));

				// 3. Spot titles that would make mapping ambiguous.
				const counts: Record<string, number> = {};
				for (const frame of frames) {
					const title = frame.title.trim();
					counts[title] = (counts[title] ?? 0) + 1;
				}
				const problems: string[] = [];
				if (frames.length === 0) problems.push('The board has no frames.');
				if (counts[''] > 0) problems.push(`${counts['']} frame(s) have no title.`);
				for (const [title, count] of Object.entries(counts)) {
					if (title && count > 1) problems.push(`Title "${title}" is used by ${count} frames.`);
				}

				returnData.push({
					json: {
						boardId,
						boardName: board.name,
						boardUrl: board.viewLink,
						frameCount: frames.length,
						frames,
						ready: problems.length === 0,
						problems,
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