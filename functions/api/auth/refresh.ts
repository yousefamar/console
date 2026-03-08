interface Env {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { refresh_token } = (await context.request.json()) as { refresh_token: string }
  if (!refresh_token) {
    return new Response(JSON.stringify({ error: 'Missing refresh_token' }), { status: 400 })
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token,
      client_id: context.env.GOOGLE_CLIENT_ID,
      client_secret: context.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })

  const data = await res.text()

  if (!res.ok) {
    // If Google says the refresh token is invalid, return 401 so the client
    // knows the user must re-authenticate from scratch.
    const parsed = JSON.parse(data)
    if (parsed.error === 'invalid_grant') {
      return new Response(data, {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(data, {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
