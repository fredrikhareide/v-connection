import { MSERep } from './mse'
import { CommandResult, createHTTPContext, HttpMSEClient, HTTPRequestError } from './msehttp'
import { getPepErrorMessage, InexistentError, PepResponse } from './peptalk'
import { has, wrapInBracesIfNeeded } from './util'
import { ElementId, ExternalElement, PlaylistGroup, VElement, VRundown, VTemplate } from './v-connection'
import { AtomEntry, FlatEntry, flattenEntry } from './xml'

interface ElementInfo {
	vcpid: number
	channel?: string
	refName: string
	refPath?: string
	name?: string
	description?: string
}

const ALTERNATIVE_CONCEPT = 'alternative_concept'

interface PlaylistResponse {
	elements?: {
		group?: Array<{
			$: { name: string; description: string }
			ref: Array<{ $: { name: string }; _: string }> | { $: { name: string }; _: string }
		}>
	}
}

export class Rundown implements VRundown {
	readonly playlist: string
	readonly profile: string
	readonly description: string

	private readonly mse: MSERep
	private get pep() {
		return this.mse.getPep()
	}
	private msehttp: HttpMSEClient
	private elementMap: Record<string, ElementInfo> = {}
	private initialElementMapPromise: Promise<boolean> | null = null
	private buildingElementMap = false

	constructor(mseRep: MSERep, profile: string, playlist: string, description: string) {
		this.mse = mseRep
		this.profile = profile.startsWith('/config/profiles/') ? profile.slice(17) : profile
		this.playlist = playlist
		if (this.playlist.startsWith('{')) {
			this.playlist = this.playlist.slice(1)
		}
		if (this.playlist.endsWith('}')) {
			this.playlist = this.playlist.slice(0, -1)
		}
		this.description = description
		this.msehttp = createHTTPContext(
			this.profile,
			this.mse.resthost ? this.mse.resthost : this.mse.hostname,
			this.mse.restPort
		)

		// Initialize element map when the rundown is created
		// This will run asynchronously in the background
		this.initialElementMapPromise = this.buildElementMap()
			.then((result) => {
				console.log('Initial element map built with size:', Object.keys(this.elementMap).length)
				return result
			})
			.catch((err) => {
				console.error('Failed to build initial element map:', getPepErrorMessage(err))
				return false
			})
	}

	private static makeKey(elementId: ElementId) {
		return `${elementId.vcpid}_${elementId.channel ?? ''}`
	}
	private static makeKeySet(elementIds: ElementId[]): Set<string> {
		return new Set(
			elementIds.map((e) => {
				return Rundown.makeKey(e)
			})
		)
	}

	private async buildElementMap(elementId?: ElementId): Promise<boolean> {
		console.log('buildElementMap called', elementId)

		// If we're looking for a specific element and it's already in the map, return immediately
		if (elementId && has(this.elementMap, Rundown.makeKey(elementId))) {
			console.log('Element already in map, returning immediately')
			return true
		}

		// If we're already building the map, wait for that to complete
		if (this.buildingElementMap) {
			console.log('Element map build already in progress, waiting...')
			// Wait a bit and check if the element is in the map
			await new Promise((resolve) => setTimeout(resolve, 500))
			if (elementId && has(this.elementMap, Rundown.makeKey(elementId))) {
				console.log('Element appeared in map while waiting')
				return true
			}
			// Wait a bit longer for the build to complete
			await new Promise((resolve) => setTimeout(resolve, 1500))
			if (elementId && has(this.elementMap, Rundown.makeKey(elementId))) {
				console.log('Element appeared in map after waiting longer')
				return true
			}
		}

		// Set the building flag
		this.buildingElementMap = true

		try {
			await this.mse.checkConnection()

			// Only handle external elements
			if (!elementId) {
				// If we're looking for a specific element, just process that one
				// Otherwise, try to get all external elements with retries if needed
				let externalElements: ElementId[]

				if (elementId) {
					externalElements = [elementId]
				} else {
					// Add a small delay before the first attempt to ensure the system is ready
					console.log('Waiting before fetching external elements...')
					await new Promise((resolve) => setTimeout(resolve, 1000))

					// Try up to 3 times to get a complete list of external elements
					let attempts = 0
					const maxAttempts = 3
					externalElements = []

					while (attempts < maxAttempts) {
						attempts++
						externalElements = await this.listExternalElements()

						// If we got more than one element, break
						if (externalElements.length > 1) {
							break
						}

						// If we've reached max attempts, break
						if (attempts >= maxAttempts) {
							break
						}

						// Wait a bit before retrying, with increasing delay
						console.log('Got only one element, retrying after delay...')
						await new Promise((resolve) => setTimeout(resolve, 1000 * attempts))
					}
				}

				// If we didn't get any elements and we're not looking for a specific one,
				// there might be an issue with the connection or data
				if (externalElements.length === 0 && !elementId) {
					console.log('Warning: No external elements found')
				}

				// Get the playlist elements to extract refPath
				const playlistElementsList = await this.pep.getJS(
					`/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/elements`,
					4
				)
				const flatPlaylistElements: FlatEntry = await flattenEntry(playlistElementsList.js as AtomEntry)

				// Helper function to find refPath for an element
				const findRefPath = (obj: any, vcpid: number): string | undefined => {
					// Base case: not an object or null
					if (!obj || typeof obj !== 'object') {
						return undefined
					}

					// Check if this is a direct reference with the matching vcpid
					if (obj.value && typeof obj.value === 'string' && obj.value.includes(`/elements/${vcpid}`)) {
						return obj.value
					}

					// Check if this is a reference with the matching path in _
					if (obj._ && typeof obj._ === 'string' && obj._.includes(`/elements/${vcpid}`)) {
						return obj._
					}

					// Recursively search all properties
					for (const key in obj) {
						// Skip certain properties that we know aren't relevant
						if (key === 'name' || key === 'id' || key === 'status') continue

						// Handle arrays
						if (Array.isArray(obj[key])) {
							for (const item of obj[key]) {
								const result = findRefPath(item, vcpid)
								if (result) return result
							}
						}
						// Handle nested objects
						else if (typeof obj[key] === 'object') {
							const result = findRefPath(obj[key], vcpid)
							if (result) return result
						}
					}

					return undefined
				}

				// Process each external element and add it to the elementMap
				for (const e of externalElements) {
					if (typeof e !== 'string') {
						try {
							const refPath = findRefPath(flatPlaylistElements, e.vcpid)

							// Try to get the element details, but don't fail if we can't
							let element: VElement | undefined
							try {
								element = await this.getElement(e)
							} catch (err) {
								console.log(`Could not get element details for ${e.vcpid}: ${getPepErrorMessage(err)}`)
							}

							// Always use 'ref' as the reference name
							this.elementMap[Rundown.makeKey(e)] = {
								vcpid: e.vcpid,
								channel: element?.channel || e.channel,
								refName: 'ref',
								refPath,
							}
						} catch (err) {
							// If we can't get the element, create a default entry
							const refPath = findRefPath(flatPlaylistElements, e.vcpid)
							this.elementMap[Rundown.makeKey(e)] = {
								vcpid: e.vcpid,
								channel: e.channel,
								refName: 'ref',
								refPath,
							}
							console.log(`Created default entry for ${e.vcpid}: ${getPepErrorMessage(err)}`)
						}
					}
				}
			}

			console.log('elementMap size:', Object.keys(this.elementMap).length)
			if (Object.keys(this.elementMap).length > 0) {
				console.log(
					'elementMap sample:',
					Object.keys(this.elementMap)
						.slice(0, 5)
						.map((key) => {
							const info = this.elementMap[key]
							return 'vcpid' in info ? `${info.vcpid}:${info.refPath?.slice(-20) || 'no-path'}` : key
						})
				)
			}

			return elementId ? has(this.elementMap, Rundown.makeKey(elementId)) : true
		} finally {
			// Always reset the building flag when done
			this.buildingElementMap = false
		}
	}

	async listTemplates(showId: string): Promise<string[]> {
		await this.mse.checkConnection()
		const templateList = await this.pep.getJS(`/storage/shows/{${showId}}/mastertemplates`, 1)
		const flatTemplates = await flattenEntry(templateList.js as AtomEntry)
		return Object.keys(flatTemplates).filter((x) => x !== 'name')
	}

	async getTemplate(templateName: string, showId: string): Promise<VTemplate> {
		await this.mse.checkConnection()
		const template = await this.pep.getJS(
			`/storage/shows/${wrapInBracesIfNeeded(showId)}/mastertemplates/${templateName}`
		)
		let flatTemplate = await flattenEntry(template.js as AtomEntry)
		if (Object.keys(flatTemplate).length === 1) {
			flatTemplate = flatTemplate[Object.keys(flatTemplate)[0]] as FlatEntry
		}
		return flatTemplate as VTemplate
	}

	async listExternalElements(): Promise<Array<ElementId>> {
		await this.mse.checkConnection()

		// First, ensure we have a fresh connection
		//console.log('Fetching external elements from playlist:', this.playlist)

		const playlistElementsList = await this.pep.getJS(
			`/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/elements`,
			4
		)
		const flatPlaylistElements: FlatEntry = await flattenEntry(playlistElementsList.js as AtomEntry)

		const elementsRefs: ElementId[] = []

		// Helper function to process entries recursively
		const processEntry = (entry: any, depth = 0) => {
			// Base case: not an object or null
			if (!entry || typeof entry !== 'object') {
				return
			}

			// Handle direct references
			if (entry.key === 'ref' && entry.value) {
				const ref = entry.value as string
				if (ref.includes('/elements/')) {
					const lastSlash = ref.lastIndexOf('/')
					elementsRefs.push({
						vcpid: +ref.slice(lastSlash + 1),
						channel: entry.viz_program as string | undefined,
					})
				}
			}
			// Handle groups
			else if (entry.key === 'group') {
				// Process refs directly in this group
				if (entry.ref) {
					const refs = Array.isArray(entry.ref) ? entry.ref : [entry.ref]
					for (const groupRef of refs) {
						if (groupRef.value) {
							const ref = groupRef.value as string
							if (ref.includes('/elements/')) {
								const lastSlash = ref.lastIndexOf('/')
								elementsRefs.push({
									vcpid: +ref.slice(lastSlash + 1),
									channel: groupRef.viz_program as string | undefined,
								})
							}
						} else if (groupRef._ && typeof groupRef._ === 'string' && groupRef._.includes('/elements/')) {
							const ref = groupRef._
							const lastSlash = ref.lastIndexOf('/')
							elementsRefs.push({
								vcpid: +ref.slice(lastSlash + 1),
								channel: (groupRef.$ && groupRef.$.viz_program) as string | undefined,
							})
						}
					}
				}

				// Process nested entries
				for (const key in entry) {
					if (typeof entry[key] === 'object' && entry[key] !== null && key !== 'ref') {
						processEntry(entry[key], depth + 1)
					}
				}
			}
			// Process all other properties recursively
			else {
				for (const key in entry) {
					// Skip certain properties that we know aren't relevant
					if (key === 'name' || key === 'id' || key === 'status') continue

					// Handle arrays
					if (Array.isArray(entry[key])) {
						for (const item of entry[key]) {
							processEntry(item, depth + 1)
						}
					}
					// Handle nested objects
					else if (typeof entry[key] === 'object' && entry[key] !== null) {
						processEntry(entry[key], depth + 1)
					}
					// Check if this is a string that contains a reference to an element
					else if (typeof entry[key] === 'string' && entry[key].includes('/elements/')) {
						const ref = entry[key] as string
						const lastSlash = ref.lastIndexOf('/')
						const vcpid = +ref.slice(lastSlash + 1)
						if (!isNaN(vcpid) && vcpid > 0) {
							elementsRefs.push({
								vcpid,
								channel: entry.viz_program as string | undefined,
							})
						}
					}
				}
			}
		}

		// Process all elements
		if (flatPlaylistElements.elements) {
			processEntry(flatPlaylistElements.elements)
		} else {
			// If no elements property, try to process the whole object
			processEntry(flatPlaylistElements)
		}

		// Remove duplicates by vcpid
		const uniqueElements = Array.from(new Map(elementsRefs.map((item) => [item.vcpid, item])).values())

		console.log(`Found ${uniqueElements.length} unique external elements`)
		return uniqueElements
	}

	async listPilotDBExternalElements(): Promise<Array<PlaylistGroup>> {
		await this.mse.checkConnection()
		const playlistElementsList = await this.pep.getJS(
			`/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/elements`,
			3
		)

		// Parse the groups and their elements
		const groups: PlaylistGroup[] = []
		const groupList = (playlistElementsList.js as PlaylistResponse)?.elements?.group || []

		for (const group of groupList) {
			const groupElements = Array.isArray(group.ref) ? group.ref : [group.ref]
			//console.log('groupElements', groupElements)
			groups.push({
				name: group.$.name,
				description: group.$.description,
				elements: (
					await Promise.all(
						groupElements.map(async (ref) => {
							const refPath = ref._
							const lastSlash = refPath.lastIndexOf('/')
							const vcpid = +refPath.slice(lastSlash + 1)

							if (!vcpid) return null
							const elementInfo = await this.getExternalPilotDbElement({ vcpid })
							return {
								name: elementInfo[vcpid]?.description || ref.$.name,
								vcpid,
								ref: ref._,
							}
						})
					)
				).filter(
					(element): element is { name: string; vcpid: number; text: string; ref: string } =>
						element !== null && typeof element.vcpid === 'number'
				),
			})
		}

		return groups
	}

	async initializeShow(showId: string): Promise<CommandResult> {
		return this.msehttp.initializeShow(showId)
	}
	async cleanupShow(showId: string): Promise<CommandResult> {
		return this.msehttp.cleanupShow(showId)
	}

	async activate(twice?: boolean, initPlaylist = true): Promise<CommandResult> {
		let result: CommandResult = {
			// Returned when initShow = false and initPlaylist = false
			path: '/',
			status: 200,
			response: 'No commands to run.',
		}
		if (twice && initPlaylist) {
			result = await this.msehttp.initializePlaylist(this.playlist)
		}
		if (initPlaylist) {
			result = await this.msehttp.initializePlaylist(this.playlist)
		}
		return result
	}

	async deactivate(): Promise<CommandResult> {
		return this.msehttp.cleanupPlaylist(this.playlist)
	}

	async deleteElement(elementId: ElementId): Promise<PepResponse> {
		// Note: For some reason, in contrast to the other commands, the delete command only works with the path being unescaped:
		const path = this.getExternalElementPath(elementId, true)
		if (await this.buildElementMap(elementId)) {
			return this.pep.delete(path)
		} else {
			console.log('Not found', path)
			throw new InexistentError(-1, path)
		}
	}

	async cue(elementId: ElementId): Promise<CommandResult> {
		const path = this.getExternalElementPath(elementId)
		if (await this.buildElementMap(elementId)) {
			return this.msehttp.cue(path)
		} else {
			throw new HTTPRequestError(
				`Cannot cue external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				path
			)
		}
	}

	async take(elementId: ElementId): Promise<CommandResult> {
		console.log('take', elementId)
		try {
			await this.buildElementMap(elementId)
			const path = this.elementMap[Rundown.makeKey(elementId)]?.refPath || ''
			return this.msehttp.take(path)
		} catch (e) {
			throw new HTTPRequestError(
				`Cannot take external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				this.elementMap[Rundown.makeKey(elementId)]?.refPath || ''
			)
		}
	}

	async continue(elementId: ElementId): Promise<CommandResult> {
		const path = this.getExternalElementPath(elementId)
		if (await this.buildElementMap(elementId)) {
			return this.msehttp.continue(path)
		} else {
			throw new HTTPRequestError(
				`Cannot continue external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				path
			)
		}
	}

	async continueReverse(elementId: ElementId): Promise<CommandResult> {
		const path = this.getExternalElementPath(elementId)
		if (await this.buildElementMap(elementId)) {
			return this.msehttp.continueReverse(path)
		} else {
			throw new HTTPRequestError(
				`Cannot continue reverse external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				path
			)
		}
	}

	async out(elementId: ElementId): Promise<CommandResult> {
		const path = this.getExternalElementPath(elementId)
		if (await this.buildElementMap(elementId)) {
			return this.msehttp.out(path)
		} else {
			throw new HTTPRequestError(
				`Cannot take out external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				path
			)
		}
	}

	async initialize(elementId: ElementId): Promise<CommandResult> {
		const path = this.getExternalElementPath(elementId)
		if (await this.buildElementMap(elementId)) {
			return this.msehttp.initialize(path)
		} else {
			throw new HTTPRequestError(
				`Cannot initialize external element as ID '${elementId.vcpid}' is not known in this rundown.`,
				this.msehttp.baseURL,
				path
			)
		}
	}

	async purgeExternalElements(elementsToKeep: ElementId[] = []): Promise<PepResponse> {
		await this.buildElementMap()
		const elementsToKeepSet = Rundown.makeKeySet(elementsToKeep)

		const deletePromises: Promise<void>[] = Object.keys(this.elementMap)
			.filter((key) => {
				const info = this.elementMap[key]
				return 'vcpid' in info // Only process external elements
			})
			.map(async (key) => {
				if (elementsToKeepSet.has(key)) return

				try {
					const info = this.elementMap[key]
					await this.deleteElement({ vcpid: info.vcpid, channel: info.channel })
				} catch (e) {
					if (!(e instanceof InexistentError)) {
						throw e
					}
				}
			})

		await Promise.allSettled(deletePromises) // Wait for all Promises
		await Promise.all(deletePromises) // throw if there are any rejected Promises

		return { id: '*', status: 'ok' } as PepResponse
	}

	async getElement(elementId: ElementId): Promise<VElement> {
		await this.mse.checkConnection()

		const playlistsList = await this.pep.getJS(`/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/elements`, 4)
		const flatPlaylistElements: FlatEntry = await flattenEntry(playlistsList.js as AtomEntry)

		// Helper function to find element recursively
		const findElementRecursively = (obj: any): any => {
			// Base case: not an object or null
			if (!obj || typeof obj !== 'object') {
				return null
			}

			// Check if this is a direct reference with the matching vcpid
			if (obj.value && typeof obj.value === 'string' && obj.value.includes(`/elements/${elementId.vcpid}`)) {
				return {
					vcpid: elementId.vcpid.toString(),
					channel: obj.viz_program,
					name: obj.key || 'ref',
					refPath: obj.value,
				}
			}

			// Check if this is a reference with the matching path in _
			if (obj._ && typeof obj._ === 'string' && obj._.includes(`/elements/${elementId.vcpid}`)) {
				return {
					vcpid: elementId.vcpid.toString(),
					channel: obj.viz_program || (obj.$ && obj.$.viz_program),
					name: (obj.$ && obj.$.name) || 'ref',
					refPath: obj._,
				}
			}

			// Check if this is a reference with a name matching the vcpid pattern
			if (obj.$ && obj.$.name && obj.$.name.startsWith(elementId.vcpid + '_')) {
				// Look for the path in this object
				if (obj._ && typeof obj._ === 'string') {
					return {
						vcpid: elementId.vcpid.toString(),
						channel: obj.viz_program || (obj.$ && obj.$.viz_program),
						name: obj.$.name,
						refPath: obj._,
					}
				}
			}

			// Recursively search all properties
			for (const key in obj) {
				// Skip certain properties that we know aren't relevant
				if (key === 'name' || key === 'id' || key === 'status') continue

				// Handle arrays
				if (Array.isArray(obj[key])) {
					for (const item of obj[key]) {
						const result = findElementRecursively(item)
						if (result) return result
					}
				}
				// Handle nested objects
				else if (typeof obj[key] === 'object') {
					const result = findElementRecursively(obj[key])
					if (result) return result
				}
			}

			return null
		}

		// Start the search from the root
		const element = findElementRecursively(flatPlaylistElements)

		if (!element) {
			throw new InexistentError(
				typeof playlistsList.id === 'number' ? playlistsList.id : 0,
				`/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/elements/${elementId.vcpid}`
			)
		} else {
			// Update the element map with the correct reference path
			this.elementMap[Rundown.makeKey(elementId)] = {
				vcpid: elementId.vcpid,
				channel: element.channel,
				refName: 'ref',
			}

			return element as ExternalElement
		}
	}

	async getExternalPilotDbElement(elementId: ElementId): Promise<any> {
		const element = await this.pep.getJS(`/external/pilotdb/elements/${elementId.vcpid}`)
		const flatPlaylistElements: FlatEntry = await flattenEntry(element.js as AtomEntry)

		return flatPlaylistElements
	}

	async isActive(): Promise<boolean> {
		const playlist = await this.mse.getPlaylist(this.playlist)
		return playlist.active_profile && typeof playlist.active_profile.value !== 'undefined'
	}

	private getExternalElementPath(elementId: ElementId, unescaped = false): string {
		// Ensure the element map is built
		this.checkElementMapWasBuilt().catch((err) => {
			console.error('Failed to check element map:', getPepErrorMessage(err))
		})

		// Get the element info from the map
		const key = Rundown.makeKey(elementId)
		const info = this.elementMap[key]

		if (!info) {
			console.warn(`Element ${key} not found in element map, using default path`)
			return `/storage/elements/${elementId.vcpid}`
		}

		// Check if this is an external element with a refPath
		if ('refPath' in info && info.refPath) {
			return unescaped ? info.refPath : encodeURIComponent(info.refPath)
		} else {
			return `/storage/elements/${elementId.vcpid}`
		}
	}

	async setAlternativeConcept(value: string): Promise<void> {
		const environmentPath = `/storage/playlists/${wrapInBracesIfNeeded(this.playlist)}/environment`
		const alternativeConceptEntry = `<entry name="${ALTERNATIVE_CONCEPT}">${value}</entry>`

		// Environment entry must exists!
		await this.pep.ensurePath(environmentPath)
		await this.pep.replace(`${environmentPath}/${ALTERNATIVE_CONCEPT}`, alternativeConceptEntry)
	}

	private async checkElementMapWasBuilt(): Promise<void> {
		// If we have elements in the map, we're good
		if (Object.keys(this.elementMap).length > 0) {
			return
		}

		// Wait for the initial build if it's in progress
		if (this.initialElementMapPromise) {
			try {
				await this.initialElementMapPromise
				console.log('Used initial element map build')

				// If the map is still empty after the initial build, rebuild it
				if (Object.keys(this.elementMap).length === 0) {
					console.log('Element map is empty after initial build, rebuilding')
					await this.buildElementMap()
				}
			} catch (err) {
				console.warn('Initial element map build failed, rebuilding:', getPepErrorMessage(err))
				await this.buildElementMap()
			}
		} else {
			// No initial build, so build the map now
			console.log('No initial element map build, building now')
			await this.buildElementMap()
		}
	}
}
