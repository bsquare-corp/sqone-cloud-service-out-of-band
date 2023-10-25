import { BadRequestError } from '@bsquare/base-service';

// Similar to CSP header see, for example:
// uuid '977fb93c-92a5-4df0-bc36-aa332c183489';
export function parseOobHeader(header: string): Record<string, string> {
  const results: Record<string, string> = {};
  const keyValuePairs = header.split(';').map((kvp) => kvp.trim());
  for (const keyValuePair of keyValuePairs) {
    if (!keyValuePair || keyValuePair.length === 0) {
      continue;
    }
    const firstSpaceIndex = keyValuePair.indexOf(' ');
    if (firstSpaceIndex <= 0) {
      throw new BadRequestError('Malformed X-OOB header - no space found');
    }
    const key = keyValuePair.substring(0, firstSpaceIndex);
    // Skip the space with a +1
    const quotedValue = keyValuePair.substring(firstSpaceIndex + 1).trim();
    if (quotedValue.length === 0) {
      throw new Error('Malformed X-OOB header - value missing');
    }
    if (!quotedValue.startsWith("'") || !quotedValue.endsWith("'")) {
      throw new BadRequestError('Malformed X-OOB header - value not quoted');
    }
    // Remove quotes from the value
    const value = quotedValue.substring(1, quotedValue.length - 1);
    results[key] = value;
  }
  return results;
}
