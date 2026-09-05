import { APIGatewayProxyEvent } from 'aws-lambda';

// Every response — including error paths — needs CORS headers, otherwise the
// browser blocks the response and the client sees a network error instead of
// the status code (e.g. the join dialog only opens when the browser can read
// the 403 PASSWORD_REQUIRED).
export function corsHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const origin = event.headers.origin || event.headers.Origin;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
  };
}
