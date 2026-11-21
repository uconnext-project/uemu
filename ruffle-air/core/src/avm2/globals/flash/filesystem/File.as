package flash.filesystem {
    import __ruffle__.airApplicationDirectoryUrl;
    import __ruffle__.airDesktopDirectoryUrl;
    import __ruffle__.airFileExists;
    import __ruffle__.airFileSize;
    import __ruffle__.stub_method;

    import flash.net.FileReference;

    [API("661")]
    public class File extends FileReference {
        private static var _applicationDirectory:File = null;
        private static var _applicationStorageDirectory:File = null;
        private static var _documentsDirectory:File = null;
        private static var _userDirectory:File = null;
        private static var _desktopDirectory:File = null;

        // All paths are stored as absolute URLs. The application directory is
        // an HTTP(S) URL served next to the root SWF; the desktop directory
        // points at a virtual filesystem backed by browser storage.
        private var _url:String;

        public function File(path:String = null) {
            super();
            this._url = path == null ? File.applicationDirectoryUrl() : File.toAbsoluteUrl(path);
        }

        private static function applicationDirectoryUrl():String {
            var url:String = airApplicationDirectoryUrl();
            if (url.length > 0 && url.charAt(url.length - 1) != "/") {
                url += "/";
            }
            return url;
        }

        private static function desktopDirectoryUrl():String {
            return airDesktopDirectoryUrl();
        }

        /**
         * Turns a path as accepted by the AIR `File` constructor into an
         * absolute URL. Relative and root-relative paths are interpreted on
         * the virtual desktop, matching how a desktop AIR application sees
         * the real filesystem.
         */
        private static function toAbsoluteUrl(path:String):String {
            if (path.indexOf("://") != -1) {
                return File.normalizeUrl(path);
            }
            var root:String = File.desktopDirectoryUrl();
            if (path.charAt(0) == "/") {
                path = path.substring(1);
            }
            return File.normalizeUrl(root + path);
        }

        /**
         * Removes `.` and `..` segments and duplicate slashes from a URL.
         */
        private static function normalizeUrl(url:String):String {
            var schemeEnd:int = url.indexOf("://");
            if (schemeEnd == -1) {
                return url;
            }

            var pathStart:int = url.indexOf("/", schemeEnd + 3);
            if (pathStart == -1) {
                return url + "/";
            }

            var prefix:String = url.substring(0, pathStart);
            var path:String = url.substring(pathStart);
            var parts:Array = path.split("/");
            var result:Array = [];
            var i:int = 0;
            for (i = 0; i < parts.length; i++) {
                var part:String = parts[i];
                if (part == "" || part == ".") {
                    continue;
                }
                if (part == "..") {
                    if (result.length > 0) {
                        result.pop();
                    }
                    continue;
                }
                result.push(part);
            }

            var normalized:String = prefix + "/" + result.join("/");
            if (url.charAt(url.length - 1) == "/" && normalized.charAt(normalized.length - 1) != "/") {
                normalized += "/";
            }
            return normalized;
        }

        /**
         * Returns the scheme and host of a URL, e.g. `vfs://desktop` or
         * `http://localhost:8080`.
         */
        private static function rootOf(url:String):String {
            var schemeEnd:int = url.indexOf("://");
            if (schemeEnd == -1) {
                return "";
            }
            var slash:int = url.indexOf("/", schemeEnd + 3);
            if (slash == -1) {
                return url;
            }
            return url.substring(0, slash);
        }

        internal function get fileUrl():String {
            return this._url;
        }

        public static function get applicationDirectory():File {
            if (_applicationDirectory === null) {
                _applicationDirectory = new File(File.applicationDirectoryUrl());
            }
            return _applicationDirectory;
        }

        public static function get applicationStorageDirectory():File {
            if (_applicationStorageDirectory === null) {
                _applicationStorageDirectory = new File(File.desktopDirectoryUrl() + "applicationStorage/");
            }
            return _applicationStorageDirectory;
        }

        public static function get documentsDirectory():File {
            if (_documentsDirectory === null) {
                _documentsDirectory = new File(File.desktopDirectoryUrl() + "documents/");
            }
            return _documentsDirectory;
        }

        public static function get userDirectory():File {
            if (_userDirectory === null) {
                _userDirectory = new File(File.desktopDirectoryUrl() + "user/");
            }
            return _userDirectory;
        }

        public static function get desktopDirectory():File {
            if (_desktopDirectory === null) {
                _desktopDirectory = new File(File.desktopDirectoryUrl());
            }
            return _desktopDirectory;
        }

        public static function get separator():String {
            return "/";
        }

        public function resolvePath(path:String):File {
            if (path == null) {
                path = "";
            }
            if (path.indexOf("://") != -1) {
                return new File(path);
            }
            if (path.charAt(0) == "/") {
                return new File(File.rootOf(this._url) + path);
            }
            var base:String = this._url;
            if (base.charAt(base.length - 1) != "/") {
                base += "/";
            }
            return new File(base + path);
        }

        public function get exists():Boolean {
            return airFileExists(this._url);
        }

        public function get nativePath():String {
            var root:String = File.desktopDirectoryUrl();
            if (this._url.indexOf(root) == 0) {
                return "/" + this._url.substring(root.length);
            }
            return this._url;
        }

        public function get url():String {
            return this._url;
        }

        override public function get name():String {
            var url:String = this._url;
            if (url.charAt(url.length - 1) == "/") {
                url = url.substring(0, url.length - 1);
            }
            var slash:int = url.lastIndexOf("/");
            return slash == -1 ? url : url.substring(slash + 1);
        }

        override public function get size():Number {
            return airFileSize(this._url);
        }

        public function get parent():File {
            var url:String = this._url;
            if (url.charAt(url.length - 1) == "/") {
                url = url.substring(0, url.length - 1);
            }
            var slash:int = url.lastIndexOf("/");
            if (slash <= File.rootOf(url).length) {
                return new File(File.rootOf(url) + "/");
            }
            return new File(url.substring(0, slash + 1));
        }

        public function get isDirectory():Boolean {
            return this._url.charAt(this._url.length - 1) == "/";
        }

        [API("661")]
        override public function get extension():String {
            var fileName:String = this.name;
            var dot:int = fileName.lastIndexOf(".");
            if (dot == -1) {
                return null;
            }
            return fileName.substring(dot + 1);
        }

        public function canonicalize():void {
            this._url = File.normalizeUrl(this._url);
        }

        public function createDirectory():void {
            // Directories are implied by file paths in the virtual filesystem.
        }

        public function deleteDirectory(deleteDirectoryContents:Boolean = false):void {
            stub_method("flash.filesystem.File", "deleteDirectory");
        }

        public function deleteFile():void {
            stub_method("flash.filesystem.File", "deleteFile");
        }

        public function getDirectoryListing():Array {
            stub_method("flash.filesystem.File", "getDirectoryListing");

            return [];
        }

        public function moveTo(newLocation:FileReference, overwrite:Boolean = false):void {
            stub_method("flash.filesystem.File", "moveTo");
        }

        public function copyTo(newLocation:FileReference, overwrite:Boolean = false):void {
            stub_method("flash.filesystem.File", "copyTo");
        }

        public function openWithDefaultApplication():void {
            stub_method("flash.filesystem.File", "openWithDefaultApplication");
        }
    }
}
