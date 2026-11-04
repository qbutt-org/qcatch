export async function cookies(...urls: string[]) {
    const selected = (await Promise.all([...new Set(urls)].map(url => chrome.cookies.getAll({ url }))))
        .flat().filter(cookie => !cookie.partitionKey).map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            hostOnly: cookie.hostOnly,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        }));
    return [...new Map(selected.map(cookie => [`${cookie.domain}\n${cookie.path}\n${cookie.name}`, cookie])).values()];
}
