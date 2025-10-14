export function wrapInBracesIfNeeded(value: string): string {
	// UUID/GUID regex pattern
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

	// If it's already wrapped in braces, return as is
	if (value.startsWith('{') && value.endsWith('}')) {
		return value
	}

	// Remove braces if present to check the raw value
	const rawValue = value.replace(/[{}]/g, '')

	// Only wrap in braces if it matches UUID pattern
	if (uuidPattern.test(rawValue)) {
		return `{${rawValue}}`
	}

	return value
}

export function has(object: Record<string | number, any>, property: string | number): boolean {
	return Object.prototype.hasOwnProperty.call(object, property)
}
