interface Env {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { code } = (await context.request.json()) as { code: string }
  if (!code) {
    return new Response(JSON.stringify({ error: 'Missing code' }), { status: 400 })
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: context.env.GOOGLE_CLIENT_ID,
      client_secret: context.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code',
    }),
  })

  const data = await res.text()
  return new Response(data, {
    status: res.ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  })
}
