import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import {
    isAirDescriptorUrl,
    parseAirApplicationDescriptor,
} from "../src/internal/air-descriptor";

// `DOMParser` is only available in browsers; jsdom provides one for the tests.
globalThis.DOMParser = new JSDOM().window.DOMParser;

const DESCRIPTOR = `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/2.5">
    <id>com.example.test</id>
    <versionNumber>1.2.3</versionNumber>
    <versionLabel>Test 1.2</versionLabel>
    <initialWindow>
        <content>test.swf</content>
        <systemChrome>none</systemChrome>
        <transparent>true</transparent>
        <visible>true</visible>
        <width>640</width>
        <height>480</height>
        <minSize>320 240</minSize>
        <maxSize>1024 800</maxSize>
        <renderMode>gpu</renderMode>
        <title>Test Application</title>
    </initialWindow>
</application>`;

describe("AIR application descriptor parsing", function () {
    it("should parse a valid descriptor", function () {
        const descriptor = parseAirApplicationDescriptor(DESCRIPTOR);
        assert.notEqual(descriptor, null);
        assert.equal(descriptor!.id, "com.example.test");
        assert.equal(descriptor!.version, "1.2.3");
        assert.equal(descriptor!.versionLabel, "Test 1.2");
        assert.equal(descriptor!.initialWindow.content, "test.swf");
        assert.equal(descriptor!.initialWindow.width, 640);
        assert.equal(descriptor!.initialWindow.height, 480);
        assert.equal(descriptor!.initialWindow.transparent, true);
        assert.equal(descriptor!.initialWindow.resizable, true);
        assert.equal(descriptor!.initialWindow.systemChrome, "none");
        assert.equal(descriptor!.initialWindow.renderMode, "gpu");
        assert.equal(descriptor!.initialWindow.title, "Test Application");
        assert.deepEqual(descriptor!.initialWindow.minSize, [320, 240]);
        assert.deepEqual(descriptor!.initialWindow.maxSize, [1024, 800]);
    });

    it("should default optional values", function () {
        const descriptor = parseAirApplicationDescriptor(`<?xml version="1.0"?>
            <application xmlns="http://ns.adobe.com/air/application/3.0">
                <initialWindow>
                    <content>movie.swf</content>
                </initialWindow>
            </application>`);
        assert.notEqual(descriptor, null);
        assert.equal(descriptor!.id, null);
        assert.equal(descriptor!.version, null);
        assert.equal(descriptor!.initialWindow.width, null);
        assert.equal(descriptor!.initialWindow.height, null);
        assert.equal(descriptor!.initialWindow.transparent, false);
        assert.equal(descriptor!.initialWindow.resizable, true);
        assert.equal(descriptor!.initialWindow.minSize, null);
    });

    it("should ignore a document without AIR namespace", function () {
        const descriptor = parseAirApplicationDescriptor(`<?xml version="1.0"?>
            <application>
                <initialWindow><content>movie.swf</content></initialWindow>
            </application>`);
        assert.equal(descriptor, null);
    });

    it("should ignore a document without content", function () {
        const descriptor = parseAirApplicationDescriptor(`<?xml version="1.0"?>
            <application xmlns="http://ns.adobe.com/air/application/2.5">
                <initialWindow><width>640</width></initialWindow>
            </application>`);
        assert.equal(descriptor, null);
    });

    it("should ignore invalid XML", function () {
        assert.equal(parseAirApplicationDescriptor("<application>"), null);
    });

    it("should detect descriptor URLs", function () {
        assert.equal(
            isAirDescriptorUrl(new URL("https://example.com/app.xml")),
            true,
        );
        assert.equal(
            isAirDescriptorUrl(new URL("https://example.com/app.XML?x=1")),
            true,
        );
        assert.equal(
            isAirDescriptorUrl(new URL("https://example.com/app.swf")),
            false,
        );
    });
});
