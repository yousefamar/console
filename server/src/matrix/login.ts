// ============================================================================
// Hub Matrix login — password flow against a Matrix homeserver.
// Produces a fresh device_id + access_token for the hub. Separate from the
// browser's device so both can coexist during the M1/M2 transition.
// ============================================================================

export type HubLoginResult = {
  homeserver: string
  userId: string
  deviceId: string
  accessToken: string
}

export async function matrixPasswordLogin(
  homeserver: string,
  userId: string,
  password: string,
  deviceDisplayName = 'Console Hub',
): Promise<HubLoginResult> {
  const hs = homeserver.replace(/\/+$/, '')
  const res = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: deviceDisplayName,
    }),
  })
  if (!res.ok) {
    throw new Error(`Matrix login failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json() as {
    access_token: string
    device_id: string
    user_id: string
    home_server?: string
    well_known?: { 'm.homeserver'?: { base_url?: string } }
  }
  return {
    homeserver: data.well_known?.['m.homeserver']?.base_url?.replace(/\/+$/, '') ?? hs,
    userId: data.user_id,
    deviceId: data.device_id,
    accessToken: data.access_token,
  }
}
