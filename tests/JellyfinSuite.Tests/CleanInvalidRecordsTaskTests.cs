using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using Xunit;

namespace JellyfinSuite.Tests;

public class CleanInvalidRecordsTaskTests : IDisposable
{
    private readonly string _dbPath;
    private readonly RecentsDatabase _db;
    private readonly Mock<IUserManager> _userManagerMock;
    private readonly Mock<ILibraryManager> _libraryManagerMock;

    public CleanInvalidRecordsTaskTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"jfs_invtest_{Guid.NewGuid()}.db");
        var logger = Mock.Of<ILogger<RecentsDatabase>>();
        _db = new RecentsDatabase(_dbPath, logger);
        _db.Initialize();

        _userManagerMock = new Mock<IUserManager>();
        _libraryManagerMock = new Mock<ILibraryManager>();
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { }
        try { File.Delete(_dbPath + "-wal"); } catch { }
        try { File.Delete(_dbPath + "-shm"); } catch { }
    }

    private void InsertRecord(string userId, string itemId, DateTime playedAt)
    {
        _db.InsertPlayRecord(Guid.Parse(userId), itemId, playedAt, "video");
    }

    private static User ValidUser() => new User("t", "Default", "Default");
    private static BaseItem ValidItem() => new Mock<BaseItem>().Object;

    [Fact]
    public async Task DeletesRecordsWithInvalidUser()
    {
        var validUser = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        var invalidUser = "deadd00d-dead-dead-dead-deadd00ddead";
        var itemId = "11111111-1111-1111-1111-111111111111";

        InsertRecord(validUser, itemId, DateTime.UtcNow);
        InsertRecord(invalidUser, itemId, DateTime.UtcNow);
        InsertRecord(invalidUser, "22222222-2222-2222-2222-222222222222", DateTime.UtcNow.AddDays(-1));

        _userManagerMock.Setup(u => u.GetUserById(Guid.Parse(validUser))).Returns(ValidUser());
        _userManagerMock.Setup(u => u.GetUserById(Guid.Parse(invalidUser))).Returns((User?)null);
        _libraryManagerMock.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns(ValidItem());

        var logger = Mock.Of<ILogger<CleanInvalidRecordsTask>>();
        var task = new CleanInvalidRecordsTask(_db,
            _userManagerMock.Object, _libraryManagerMock.Object, logger);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        var (entries, count) = _db.GetPlayHistoryPage(
            Guid.Parse(validUser), 0, 10, true, null, "playedDate", "desc");
        Assert.Equal(1, count);
    }

    [Fact]
    public async Task DeletesRecordsWithInvalidItem()
    {
        var user = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        var validItem = "11111111-1111-1111-1111-111111111111";
        var invalidItem = "bad11111-1111-1111-1111-111111111111";

        InsertRecord(user, validItem, DateTime.UtcNow);
        InsertRecord(user, invalidItem, DateTime.UtcNow);
        InsertRecord(user, invalidItem, DateTime.UtcNow.AddDays(-1));

        _userManagerMock.Setup(u => u.GetUserById(Guid.Parse(user))).Returns(ValidUser());
        _libraryManagerMock.Setup(l => l.GetItemById(Guid.Parse(validItem))).Returns(ValidItem());
        _libraryManagerMock.Setup(l => l.GetItemById(Guid.Parse(invalidItem))).Returns((BaseItem?)null);

        var logger = Mock.Of<ILogger<CleanInvalidRecordsTask>>();
        var task = new CleanInvalidRecordsTask(_db,
            _userManagerMock.Object, _libraryManagerMock.Object, logger);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        var (entries, count) = _db.GetPlayHistoryPage(
            Guid.Parse(user), 0, 10, true, null, "playedDate", "desc");
        Assert.Equal(1, count);
    }

    [Fact]
    public async Task AllValid_DeletesNothing()
    {
        var user = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        InsertRecord(user, "11111111-1111-1111-1111-111111111111", DateTime.UtcNow);
        InsertRecord(user, "22222222-2222-2222-2222-222222222222", DateTime.UtcNow);

        _userManagerMock.Setup(u => u.GetUserById(Guid.Parse(user))).Returns(ValidUser());
        _libraryManagerMock.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns(ValidItem());

        var logger = Mock.Of<ILogger<CleanInvalidRecordsTask>>();
        var task = new CleanInvalidRecordsTask(_db,
            _userManagerMock.Object, _libraryManagerMock.Object, logger);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        var (entries, count) = _db.GetPlayHistoryPage(
            Guid.Parse(user), 0, 10, true, null, "playedDate", "desc");
        Assert.Equal(2, count);
    }
}
