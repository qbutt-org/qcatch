export async function cookies(url: string) {
    return (await chrome.cookies.getAll({ url })).filter(cookie => !cookie.partitionKey).map(cookie => ({
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
}
