/**
 * Parsing support for Adobe AIR application descriptor files.
 *
 * An AIR application is described by an XML file, usually named
 * `<application>-app.xml` or `application.xml`. The descriptor points at the
 * initial content (normally a SWF file) and describes the initial window.
 *
 * Ruffle cannot install a real AIR application, but it can emulate one well
 * enough for the browser: the descriptor is used to find the root SWF and to
 * configure the player (AIR API version, window size, transparency, ...).
 */

/**
 * The `initialWindow` element of an AIR application descriptor.
 */
export interface AirInitialWindow {
    /** URL of the initial content, relative to the descriptor. */
    content: string;

    /** Initial window width, or `null` if it should be taken from the SWF. */
    width: number | null;

    /** Initial window height, or `null` if it should be taken from the SWF. */
    height: number | null;

    /** Whether the application window is transparent. */
    transparent: boolean;

    /** Whether the application window is resizable. */
    resizable: boolean;

    /** `"standard"` or `"none"`. */
    systemChrome: string | null;

    /** `"auto"`, `"cpu"`, `"gpu"` or `"direct"`. */
    renderMode: string | null;

    /** The window title. */
    title: string | null;

    /** The minimum window size, if specified. */
    minSize: [number, number] | null;

    /** The maximum window size, if specified. */
    maxSize: [number, number] | null;
}

/**
 * A parsed AIR application descriptor.
 */
export interface AirApplicationDescriptor {
    /** The application ID. */
    id: string | null;

    /** The application version (`versionNumber` or `version`). */
    version: string | null;

    /** The application version as shown to the user. */
    versionLabel: string | null;

    /** The initial window settings. */
    initialWindow: AirInitialWindow;
}

const AIR_NAMESPACE_PREFIX = "http://ns.adobe.com/air/application/";

/**
 * Checks whether a URL could point at an AIR application descriptor.
 *
 * Any XML file is a candidate: the content is verified by
 * {@link parseAirApplicationDescriptor} before it is used.
 *
 * @param url The URL to check.
 * @returns Whether the URL may be an AIR application descriptor.
 */
export function isAirDescriptorUrl(url: URL): boolean {
    return /\.xml$/i.test(url.pathname);
}

/**
 * Returns the first direct child element with the given local name.
 *
 * AIR descriptors use a default XML namespace, and the namespace changed
 * between AIR versions, so local names are used instead of namespace-aware
 * lookups.
 *
 * @param parent The parent element.
 * @param name The local name of the child element.
 * @returns The child element, if present.
 */
function childElement(parent: Element, name: string): Element | null {
    for (const child of Array.from(parent.children)) {
        if (child.localName === name) {
            return child;
        }
    }
    return null;
}

/**
 * Returns the trimmed text of the first direct child element with the given
 * local name.
 *
 * @param parent The parent element.
 * @param name The local name of the child element.
 * @returns The text, or `null` if the element is missing or empty.
 */
function childText(parent: Element, name: string): string | null {
    const child = childElement(parent, name);
    if (child === null) {
        return null;
    }
    const text = child.textContent?.trim() ?? "";
    return text.length > 0 ? text : null;
}

/**
 * Parses a boolean element the same way AIR does.
 *
 * @param parent The parent element.
 * @param name The local name of the child element.
 * @param defaultValue Value to use when the element is missing or invalid.
 * @returns The parsed boolean.
 */
function childBoolean(
    parent: Element,
    name: string,
    defaultValue: boolean,
): boolean {
    const text = childText(parent, name);
    if (text === null) {
        return defaultValue;
    }
    return text.toLowerCase() === "true" || text === "1";
}

/**
 * Parses an unsigned integer (window dimension) element.
 *
 * @param parent The parent element.
 * @param name The local name of the child element.
 * @returns The dimension, or `null` if the element is missing or invalid.
 */
function childDimension(parent: Element, name: string): number | null {
    const text = childText(parent, name);
    if (text === null) {
        return null;
    }
    const value = Number.parseInt(text, 10);
    // AIR window dimensions are limited to 4095 pixels (0-based coordinates).
    if (!Number.isFinite(value) || value <= 0 || value > 4095) {
        return null;
    }
    return value;
}

/**
 * Parses a size element, such as `<minSize>320 240</minSize>`.
 *
 * @param parent The parent element.
 * @param name The local name of the child element.
 * @returns The width/height pair, or `null` if the element is missing or invalid.
 */
function childSize(parent: Element, name: string): [number, number] | null {
    const text = childText(parent, name);
    if (text === null) {
        return null;
    }
    const parts = text.split(/\s+/);
    if (parts.length !== 2) {
        return null;
    }
    const width = Number.parseInt(parts[0]!, 10);
    const height = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }
    return [width, height];
}

/**
 * Parses an AIR application descriptor.
 *
 * @param xml The contents of the descriptor file.
 * @returns The parsed descriptor, or `null` if the document is not an AIR
 * application descriptor.
 */
export function parseAirApplicationDescriptor(
    xml: string,
): AirApplicationDescriptor | null {
    let document: Document;
    try {
        document = new DOMParser().parseFromString(xml, "application/xml");
    } catch {
        return null;
    }

    if (document.querySelector("parsererror") !== null) {
        return null;
    }

    const root = document.documentElement;
    if (
        root === null ||
        root.localName !== "application" ||
        !root.namespaceURI?.startsWith(AIR_NAMESPACE_PREFIX)
    ) {
        return null;
    }

    const initialWindow = childElement(root, "initialWindow");
    if (initialWindow === null) {
        return null;
    }

    const content = childText(initialWindow, "content");
    if (content === null) {
        // An AIR application must have a content file.
        return null;
    }

    return {
        id: childText(root, "id"),
        version: childText(root, "versionNumber") ?? childText(root, "version"),
        versionLabel: childText(root, "versionLabel"),
        initialWindow: {
            content,
            width: childDimension(initialWindow, "width"),
            height: childDimension(initialWindow, "height"),
            transparent: childBoolean(initialWindow, "transparent", false),
            resizable: childBoolean(initialWindow, "resizable", true),
            systemChrome: childText(initialWindow, "systemChrome"),
            renderMode: childText(initialWindow, "renderMode"),
            title: childText(initialWindow, "title"),
            minSize: childSize(initialWindow, "minSize"),
            maxSize: childSize(initialWindow, "maxSize"),
        },
    };
}

/**
 * Downloads and parses an AIR application descriptor.
 *
 * If the URL is not an XML file, no request is made.
 *
 * @param url The URL of the descriptor.
 * @returns The parsed descriptor, or `null` if the file is not an AIR
 * application descriptor.
 */
export async function loadAirApplicationDescriptor(
    url: URL,
): Promise<AirApplicationDescriptor | null> {
    if (!isAirDescriptorUrl(url)) {
        return null;
    }

    const response = await fetch(url.href, {
        credentials: "same-origin",
    });
    if (!response.ok) {
        throw new Error(
            `Could not download AIR application descriptor ${url.href} (HTTP ${response.status})`,
        );
    }

    const xml = await response.text();
    return parseAirApplicationDescriptor(xml);
}

/**
 * Resolves the initial content of an AIR application against the descriptor
 * URL.
 *
 * @param descriptorUrl The URL of the descriptor file.
 * @param descriptor The parsed descriptor.
 * @returns The absolute URL of the initial content.
 */
export function resolveAirContentUrl(
    descriptorUrl: URL,
    descriptor: AirApplicationDescriptor,
): URL {
    return new URL(descriptor.initialWindow.content, descriptorUrl);
}
